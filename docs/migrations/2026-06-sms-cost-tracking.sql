-- SOLAPI 발송 비용 추적.
-- ----------------------------------------------------------------
-- outbound 메시지가 INSERT될 때 트리거가 body 길이를 보고 SMS/LMS/MMS/ALIMTALK 분류 + 단가 자동 기록.
-- 코드 변경 없음 — 9개 outbound INSERT 지점이 흩어져 있어서 일괄 누락 없게 DB 레이어에서 처리.
--
-- SOLAPI 단가 (KRW):
--   SMS      : ≤ 90 bytes (EUC-KR)         18원
--   LMS      : 91 ~ 2000 bytes             45원
--   MMS      : > 2000 bytes 또는 이미지    110원
--   ALIMTALK : 카카오 알림톡 (템플릿)      8원   ← 계약별 다를 수 있음
--
-- 분류 기준은 EUC-KR 바이트 길이 (한글 2바이트, ASCII 1바이트). UTF-8(한글 3바이트)이 아님.

-- 1) 컬럼 추가
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sms_type     TEXT,
  ADD COLUMN IF NOT EXISTS sms_cost_krw INT;

-- 2) EUC-KR 바이트 길이 헬퍼 함수 (Postgres는 기본 UTF-8이라 직접 계산 필요)
CREATE OR REPLACE FUNCTION euc_kr_byte_length(s TEXT) RETURNS INT AS $$
DECLARE
  total INT := 0;
  i INT;
  c INT;
BEGIN
  IF s IS NULL THEN RETURN 0; END IF;
  FOR i IN 1..length(s) LOOP
    c := ascii(substr(s, i, 1));
    total := total + CASE WHEN c < 128 THEN 1 ELSE 2 END;
  END LOOP;
  RETURN total;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 3) outbound INSERT 시 자동 분류 트리거
CREATE OR REPLACE FUNCTION classify_outbound_sms() RETURNS TRIGGER AS $$
DECLARE
  bytes INT;
BEGIN
  -- 이미 채워진 경우(예: 백필 UPDATE)는 건드리지 않음
  IF NEW.direction = 'outbound' AND NEW.sms_type IS NULL THEN
    IF NEW.message_type = 'alimtalk' THEN
      NEW.sms_type := 'ALIMTALK';
      NEW.sms_cost_krw := 8;
    ELSE
      bytes := euc_kr_byte_length(COALESCE(NEW.body, ''));
      IF bytes <= 90 THEN
        NEW.sms_type := 'SMS';
        NEW.sms_cost_krw := 18;
      ELSIF bytes <= 2000 THEN
        NEW.sms_type := 'LMS';
        NEW.sms_cost_krw := 45;
      ELSE
        NEW.sms_type := 'MMS';
        NEW.sms_cost_krw := 110;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_classify_outbound_sms ON messages;
CREATE TRIGGER tr_classify_outbound_sms
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION classify_outbound_sms();

-- 4) 기존 outbound 행 백필 — 트리거는 INSERT만 잡으므로 과거 데이터는 수동 채움
UPDATE messages SET
  sms_type = CASE
    WHEN message_type = 'alimtalk' THEN 'ALIMTALK'
    WHEN euc_kr_byte_length(COALESCE(body,'')) <= 90    THEN 'SMS'
    WHEN euc_kr_byte_length(COALESCE(body,'')) <= 2000  THEN 'LMS'
    ELSE 'MMS'
  END,
  sms_cost_krw = CASE
    WHEN message_type = 'alimtalk' THEN 8
    WHEN euc_kr_byte_length(COALESCE(body,'')) <= 90    THEN 18
    WHEN euc_kr_byte_length(COALESCE(body,'')) <= 2000  THEN 45
    ELSE 110
  END
WHERE direction = 'outbound' AND sms_type IS NULL;

-- 5) AI + SMS 통합 일별 비용 view
-- 어드민 대시보드 카드용. 환율 1400원 가정. AI 모델 단가는 Anthropic 공식 가격(USD / MTok).
CREATE OR REPLACE VIEW usage_daily_cost AS
WITH ai AS (
  SELECT day,
    SUM((tokens_in  * CASE model
           WHEN 'claude-sonnet-4-6'         THEN 3.00
           WHEN 'claude-haiku-4-5-20251001' THEN 1.00
           ELSE 0 END)
      + (tokens_out * CASE model
           WHEN 'claude-sonnet-4-6'         THEN 15.00
           WHEN 'claude-haiku-4-5-20251001' THEN 5.00
           ELSE 0 END)
      + (cache_read * CASE model
           WHEN 'claude-sonnet-4-6'         THEN 0.30
           WHEN 'claude-haiku-4-5-20251001' THEN 0.10
           ELSE 0 END)
    ) / 1000000.0 AS ai_cost_usd,
    SUM(call_count) AS ai_call_count
  FROM ai_usage_daily
  GROUP BY day
),
sms AS (
  SELECT
    DATE(created_at AT TIME ZONE 'Asia/Seoul') AS day,
    SUM(sms_cost_krw) AS sms_cost_krw,
    COUNT(*) FILTER (WHERE sms_type = 'SMS')      AS sms_count,
    COUNT(*) FILTER (WHERE sms_type = 'LMS')      AS lms_count,
    COUNT(*) FILTER (WHERE sms_type = 'MMS')      AS mms_count,
    COUNT(*) FILTER (WHERE sms_type = 'ALIMTALK') AS alimtalk_count
  FROM messages
  WHERE direction = 'outbound' AND sms_cost_krw IS NOT NULL
  GROUP BY 1
)
SELECT
  COALESCE(ai.day, sms.day) AS day,
  COALESCE(ai.ai_cost_usd, 0)              AS ai_cost_usd,
  ROUND(COALESCE(ai.ai_cost_usd, 0) * 1400) AS ai_cost_krw,
  COALESCE(sms.sms_cost_krw, 0)            AS sms_cost_krw,
  ROUND(COALESCE(ai.ai_cost_usd, 0) * 1400 + COALESCE(sms.sms_cost_krw, 0)) AS total_cost_krw,
  COALESCE(ai.ai_call_count, 0)   AS ai_call_count,
  COALESCE(sms.sms_count, 0)      AS sms_count,
  COALESCE(sms.lms_count, 0)      AS lms_count,
  COALESCE(sms.mms_count, 0)      AS mms_count,
  COALESCE(sms.alimtalk_count, 0) AS alimtalk_count
FROM ai
FULL OUTER JOIN sms USING (day)
ORDER BY day DESC;
