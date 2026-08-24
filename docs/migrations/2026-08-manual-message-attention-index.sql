-- P0: /live의 재발송 금지 수동 SMS 확인 큐 조회를 활성 outbox 행에 한정한다.
-- 선행: 2026-08-manual-message-idempotency.sql, 2026-08-manual-message-recovery.sql
-- 전체 목록은 60초, 열린 대화는 12초마다 이 상태를 읽으므로 누적된 recorded/failed 행을
-- 반복 스캔하지 않게 applicant_id + created_at partial index를 둔다.

CREATE INDEX IF NOT EXISTS manual_message_send_requests_attention_applicant_idx
  ON public.manual_message_send_requests (applicant_id, created_at)
  WHERE status IN ('sending', 'unknown', 'sent');

COMMENT ON INDEX public.manual_message_send_requests_attention_applicant_idx IS
  '재발송 금지 상태(sending/unknown/sent)의 지원자별 oldest-first 관리 화면 조회용 partial index.';
