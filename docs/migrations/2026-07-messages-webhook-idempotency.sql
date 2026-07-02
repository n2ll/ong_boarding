-- P0-2: Supabase webhook 재전송(at-least-once) 대비 멱등성 claim 컬럼.
-- ----------------------------------------------------------------
-- 문제:
--   Supabase DB Webhook은 at-least-once 전송이라 같은 messages INSERT를
--   webhook으로 두 번 이상 쏠 수 있다. 기존 유일한 가드는
--   `classification IS NULL`(supabase-new-message/route.ts) 뿐이었는데,
--   "기존 applicant 매칭" 분기는 classification을 절대 쓰지 않으므로
--   재전송 때마다 runAgentForCandidate가 다시 돌아 중복 SMS가 나갔다.
--
-- 해결:
--   classification과 무관한 전용 claim 컬럼을 둔다. webhook은 처리 직전
--   `UPDATE ... SET webhook_processed_at = now() WHERE id = ? AND webhook_processed_at IS NULL`
--   로 행을 '선점'하고, 갱신된 행이 0건이면(=이미 다른 전송이 선점) 즉시 skip한다.
--
-- 왜 classification 재사용 대신 새 컬럼인가:
--   - inbox/pending, notifications, automation 이 셋 모두 `classification='pending'`으로
--     미분류 인박스/뱃지/Slack 집계를 돌린다. 매칭 분기에 임의 sentinel을 넣으면
--     이 뷰들에 엉뚱하게 노출된다.
--   - classification CHECK는 ('baemin','pending','other')로 고정돼 있어 새 sentinel 값은
--     제약 위반으로 UPDATE 자체가 실패한다.
--   - message-history 뷰(messages/[applicantId])는 classification을 읽지 않으므로
--     claim 컬럼은 어떤 화면에도 나타나지 않는다.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS webhook_processed_at TIMESTAMPTZ;

COMMENT ON COLUMN messages.webhook_processed_at IS
  'supabase-new-message webhook이 이 inbound 행을 선점 처리한 시각. NULL이면 미처리. 재전송 멱등성 claim 전용 — classification과 무관, 어떤 UI/집계에도 노출되지 않음.';
