-- Claude API 사용량 추적.
-- ----------------------------------------------------------------
-- 모든 Claude 호출(스크리닝/온보딩/탐색 에이전트, 배민 triage, 공고 생성/추출)이
-- 응답의 usage 블록을 두 곳에 기록한다:
--   1) messages 테이블의 컬럼  : 메시지별 토큰 비용 (outbound AI 답장 + inbound triage)
--   2) ai_usage_daily 테이블   : (KST 일자, 모델, 용도) 일별 집계 — 비메시지 호출 포함
-- 비용 환산은 view 단계에서 처리 (모델별 단가는 변경 가능성 있으므로 저장 X).

-- 1) messages에 메시지별 토큰 컬럼 추가
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS model              TEXT,
  ADD COLUMN IF NOT EXISTS tokens_in          INT,
  ADD COLUMN IF NOT EXISTS tokens_out         INT,
  ADD COLUMN IF NOT EXISTS cache_read_tokens  INT;

-- 2) 일별 집계 테이블 — (day, model, purpose) 복합 PK로 UPSERT
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day         DATE   NOT NULL,
  model       TEXT   NOT NULL,
  purpose     TEXT   NOT NULL,   -- 'screening' | 'onboarding' | 'exploration'
                                 -- | 'triage' | 'job_generate' | 'job_extract'
  tokens_in   BIGINT NOT NULL DEFAULT 0,
  tokens_out  BIGINT NOT NULL DEFAULT 0,
  cache_read  BIGINT NOT NULL DEFAULT 0,
  call_count  INT    NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, purpose)
);

-- 3) UPSERT helper — JS에서 supabase.rpc('upsert_ai_usage_daily', ...) 로 호출
CREATE OR REPLACE FUNCTION upsert_ai_usage_daily(
  p_day     DATE,
  p_model   TEXT,
  p_purpose TEXT,
  p_in      INT,
  p_out     INT,
  p_cache   INT
) RETURNS void AS $$
  INSERT INTO ai_usage_daily(day, model, purpose, tokens_in, tokens_out, cache_read, call_count)
  VALUES (p_day, p_model, p_purpose, p_in, p_out, p_cache, 1)
  ON CONFLICT (day, model, purpose) DO UPDATE SET
    tokens_in  = ai_usage_daily.tokens_in  + EXCLUDED.tokens_in,
    tokens_out = ai_usage_daily.tokens_out + EXCLUDED.tokens_out,
    cache_read = ai_usage_daily.cache_read + EXCLUDED.cache_read,
    call_count = ai_usage_daily.call_count + 1;
$$ LANGUAGE sql;
