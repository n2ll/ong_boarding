-- 2026-07-usage-cost-krw-1500.sql
-- usage_daily_cost 뷰의 USD→KRW 환율 가정을 1,400 → 1,500원으로 갱신(사용자 결정, I-3).
-- 뷰 로직·컬럼 불변, ai_cost_krw/total_cost_krw 계산 상수만 1400→1500.
-- (AI 비용은 토큰×USD 단가로 산출된 ai_cost_usd에 환율을 곱한 추정치. SMS는 원화 실비.)

CREATE OR REPLACE VIEW usage_daily_cost AS
WITH ai AS (
  SELECT ai_usage_daily.day,
    sum(ai_usage_daily.tokens_in::numeric *
      CASE ai_usage_daily.model
        WHEN 'claude-sonnet-4-6'::text THEN 3.00
        WHEN 'claude-haiku-4-5-20251001'::text THEN 1.00
        ELSE 0::numeric END
    + ai_usage_daily.tokens_out::numeric *
      CASE ai_usage_daily.model
        WHEN 'claude-sonnet-4-6'::text THEN 15.00
        WHEN 'claude-haiku-4-5-20251001'::text THEN 5.00
        ELSE 0::numeric END
    + ai_usage_daily.cache_read::numeric *
      CASE ai_usage_daily.model
        WHEN 'claude-sonnet-4-6'::text THEN 0.30
        WHEN 'claude-haiku-4-5-20251001'::text THEN 0.10
        ELSE 0::numeric END) / 1000000.0 AS ai_cost_usd,
    sum(ai_usage_daily.call_count) AS ai_call_count
  FROM ai_usage_daily
  GROUP BY ai_usage_daily.day
), sms AS (
  SELECT date((messages.created_at AT TIME ZONE 'Asia/Seoul'::text)) AS day,
    sum(messages.sms_cost_krw) AS sms_cost_krw,
    count(*) FILTER (WHERE messages.sms_type = 'SMS'::text) AS sms_count,
    count(*) FILTER (WHERE messages.sms_type = 'LMS'::text) AS lms_count,
    count(*) FILTER (WHERE messages.sms_type = 'MMS'::text) AS mms_count,
    count(*) FILTER (WHERE messages.sms_type = 'ALIMTALK'::text) AS alimtalk_count
  FROM messages
  WHERE messages.direction = 'outbound'::text AND messages.sms_cost_krw IS NOT NULL
  GROUP BY (date((messages.created_at AT TIME ZONE 'Asia/Seoul'::text)))
)
SELECT COALESCE(ai.day, sms.day) AS day,
  COALESCE(ai.ai_cost_usd, 0::numeric) AS ai_cost_usd,
  round(COALESCE(ai.ai_cost_usd, 0::numeric) * 1500::numeric) AS ai_cost_krw,
  COALESCE(sms.sms_cost_krw, 0::bigint) AS sms_cost_krw,
  round(COALESCE(ai.ai_cost_usd, 0::numeric) * 1500::numeric + COALESCE(sms.sms_cost_krw, 0::bigint)::numeric) AS total_cost_krw,
  COALESCE(ai.ai_call_count, 0::bigint) AS ai_call_count,
  COALESCE(sms.sms_count, 0::bigint) AS sms_count,
  COALESCE(sms.lms_count, 0::bigint) AS lms_count,
  COALESCE(sms.mms_count, 0::bigint) AS mms_count,
  COALESCE(sms.alimtalk_count, 0::bigint) AS alimtalk_count
FROM ai
FULL JOIN sms USING (day)
ORDER BY (COALESCE(ai.day, sms.day)) DESC;
