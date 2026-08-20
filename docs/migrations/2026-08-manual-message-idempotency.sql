-- P0: 매니저 수동 SMS의 발송-기록 사이 실패 및 네트워크 재시도 중복 발송 방지.
-- -----------------------------------------------------------------------------
-- 실제 messages 행을 SMS 전에 선점하면 match_applicant_on_message 트리거가
-- applicants.last_message_at을 올려, 아직 발송되지 않은 문자가 대화 활동으로 보인다.
-- 따라서 외부 발송 의도는 service-role 전용 outbox에 먼저 보존한다.
--
-- 상태 계약:
--   sending  : 이 key를 한 요청이 선점함. 결과가 불명확하므로 replay 발송 금지.
--   unknown  : 공급자 호출 예외. 결과가 불명확하므로 replay 발송 금지.
--   failed   : 공급자가 실패를 확정. 다시 보내려면 반드시 새 key 사용.
--   sent     : 공급자 성공을 먼저 보존. messages 기록 실패 시 replay가 기록만 복구.
--   recorded : 실제 messages 행까지 기록됨. replay는 unique key로 중복 기록 방지.

CREATE TABLE IF NOT EXISTS public.manual_message_send_requests (
  idempotency_key UUID PRIMARY KEY,
  applicant_id BIGINT,
  applicant_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  job_id BIGINT,
  sent_by TEXT NOT NULL,
  draft_id TEXT,
  draft_was_edited BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending', 'unknown', 'failed', 'sent', 'recorded')),
  provider_message_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ
);

COMMENT ON TABLE public.manual_message_send_requests IS
  '매니저 수동 SMS 발송 outbox. service role만 접근하며 SMS 성공 전 messages 트리거를 발생시키지 않는다.';
COMMENT ON COLUMN public.manual_message_send_requests.idempotency_key IS
  '브라우저가 발송 의도마다 생성하는 UUID. 동일 key replay는 SMS를 재발송하지 않는다.';

ALTER TABLE public.manual_message_send_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.manual_message_send_requests FROM PUBLIC;
REVOKE ALL ON TABLE public.manual_message_send_requests FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.manual_message_send_requests TO service_role;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS client_request_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS messages_client_request_id_uidx
  ON public.messages (client_request_id)
  WHERE client_request_id IS NOT NULL;

COMMENT ON COLUMN public.messages.client_request_id IS
  '매니저 수동 SMS outbox key. 공급자 성공 뒤 실제 대화 기록을 복구할 때도 중복 행을 막는다.';
