-- P1: 수동 SMS outbox의 무발송 복구 sweep 및 SOLAPI exact-correlation 상태.
-- -----------------------------------------------------------------------------
-- 선행:
--   2026-08-manual-message-idempotency.sql
--   2026-08-manual-message-postprocess.sql
--
-- 새 수동 발송은 caller UUID를 SOLAPI customFields에도 싣는다. 공급자 성공 직후
-- outbox sent 기록이 끊긴 극단 구간은 이 UUID가 정확히 일치하는 공급자 내역만
-- read-only로 확인해 복구한다. 전화번호·본문·시각 유사성만으로는 절대 복구하지 않는다.

ALTER TABLE public.manual_message_send_requests
  ADD COLUMN IF NOT EXISTS provider_correlation_attached BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS provider_reconcile_status TEXT NOT NULL DEFAULT 'not_attached',
  ADD COLUMN IF NOT EXISTS provider_reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_reconcile_last_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_reconcile_last_error TEXT,
  ADD COLUMN IF NOT EXISTS provider_reconciled_at TIMESTAMPTZ;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'manual_message_send_requests_provider_reconcile_status_check'
      AND conrelid = 'public.manual_message_send_requests'::regclass
  ) THEN
    ALTER TABLE public.manual_message_send_requests
      ADD CONSTRAINT manual_message_send_requests_provider_reconcile_status_check
      CHECK (provider_reconcile_status IN ('not_attached', 'pending', 'matched', 'unresolved'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'manual_message_send_requests_provider_reconcile_attempts_check'
      AND conrelid = 'public.manual_message_send_requests'::regclass
  ) THEN
    ALTER TABLE public.manual_message_send_requests
      ADD CONSTRAINT manual_message_send_requests_provider_reconcile_attempts_check
      CHECK (provider_reconcile_attempts >= 0);
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS manual_message_send_requests_postprocess_pending_idx
  ON public.manual_message_send_requests (created_at, idempotency_key)
  WHERE status = 'recorded' AND postprocess_status = 'pending';

CREATE INDEX IF NOT EXISTS manual_message_send_requests_sent_recovery_idx
  ON public.manual_message_send_requests (created_at, idempotency_key)
  WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS manual_message_send_requests_provider_recovery_idx
  ON public.manual_message_send_requests (created_at, idempotency_key)
  WHERE provider_correlation_attached IS TRUE
    AND provider_reconcile_status = 'pending'
    AND status IN ('sending', 'unknown');

COMMENT ON COLUMN public.manual_message_send_requests.provider_correlation_attached IS
  'TRUE면 이 outbox UUID를 SOLAPI customFields에 넣어 호출한 코드 경로. provider 조회 복구의 필수 조건.';
COMMENT ON COLUMN public.manual_message_send_requests.provider_reconcile_status IS
  'not_attached=공급자 상관키 없음, pending=exact 조회 대기, matched=공급자 내역 일치, unresolved=bounded 조회 후 수동 확인 필요.';
COMMENT ON COLUMN public.manual_message_send_requests.provider_reconcile_attempts IS
  'SOLAPI read-only exact-correlation 조회 횟수. 한도 초과 시 unresolved로 남고 자동 재발송하지 않는다.';

-- 공급자 조회 전에 횟수를 먼저 선점한다. 외부 조회 중 함수 트랜잭션 잠금은 유지할 수
-- 없으므로, 이 누적 카운터가 중첩 cron에서도 전체 조회 횟수를 상한 안에 묶는다.
CREATE OR REPLACE FUNCTION public.claim_manual_message_provider_reconciliation(
  p_idempotency_key UUID,
  p_max_attempts INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.manual_message_send_requests%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR p_max_attempts < 1 OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'invalid provider reconciliation claim' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_request
  FROM public.manual_message_send_requests
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF NOT FOUND
     OR v_request.provider_correlation_attached IS NOT TRUE
     OR v_request.status NOT IN ('sending', 'unknown')
     OR v_request.provider_reconcile_status <> 'pending' THEN
    RETURN 'unavailable';
  END IF;

  IF v_request.provider_reconcile_attempts >= p_max_attempts THEN
    UPDATE public.manual_message_send_requests
    SET
      provider_reconcile_status = 'unresolved',
      provider_reconcile_last_at = clock_timestamp(),
      provider_reconcile_last_error = COALESCE(
        provider_reconcile_last_error,
        'provider reconciliation attempts exhausted'
      ),
      updated_at = clock_timestamp()
    WHERE idempotency_key = p_idempotency_key;
    RETURN 'exhausted';
  END IF;

  UPDATE public.manual_message_send_requests
  SET
    provider_reconcile_attempts = provider_reconcile_attempts + 1,
    provider_reconcile_last_at = clock_timestamp(),
    provider_reconcile_last_error = NULL,
    updated_at = clock_timestamp()
  WHERE idempotency_key = p_idempotency_key;

  RETURN 'claimed';
END;
$$;

-- exact custom-field 일치를 확인한 경우에만 불명 상태를 sent로 전진시킨다.
-- 전화번호·본문·시각 유사성만으로 이 함수를 호출하는 것은 애플리케이션 계약 위반이다.
CREATE OR REPLACE FUNCTION public.record_manual_message_provider_match(
  p_idempotency_key UUID,
  p_provider_message_id TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.manual_message_send_requests%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL
     OR p_provider_message_id IS NULL
     OR btrim(p_provider_message_id) = '' THEN
    RAISE EXCEPTION 'invalid provider reconciliation match' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_request
  FROM public.manual_message_send_requests
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'unavailable';
  END IF;
  IF v_request.status IN ('sent', 'recorded')
     AND v_request.provider_message_id IS NOT DISTINCT FROM p_provider_message_id THEN
    RETURN 'deduped';
  END IF;
  IF v_request.provider_correlation_attached IS NOT TRUE
     OR v_request.provider_reconcile_status <> 'pending'
     OR v_request.status NOT IN ('sending', 'unknown') THEN
    RETURN 'unchanged';
  END IF;

  UPDATE public.manual_message_send_requests
  SET
    status = 'sent',
    provider_message_id = p_provider_message_id,
    sent_at = COALESCE(sent_at, clock_timestamp()),
    last_error = NULL,
    provider_reconcile_status = 'matched',
    provider_reconciled_at = clock_timestamp(),
    provider_reconcile_last_error = NULL,
    updated_at = clock_timestamp()
  WHERE idempotency_key = p_idempotency_key;

  RETURN 'matched';
END;
$$;

-- exact 일치를 찾지 못했거나 조회 자체가 실패한 경우 횟수만 보존한다. 마지막 허용
-- 시도였다면 unresolved로 닫고, outbox status는 sending/unknown 그대로 둬 재발송을 막는다.
CREATE OR REPLACE FUNCTION public.record_manual_message_provider_miss(
  p_idempotency_key UUID,
  p_max_attempts INTEGER,
  p_error TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.manual_message_send_requests%ROWTYPE;
  v_next_status TEXT;
BEGIN
  IF p_idempotency_key IS NULL OR p_max_attempts < 1 OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'invalid provider reconciliation miss' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_request
  FROM public.manual_message_send_requests
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF NOT FOUND
     OR v_request.provider_correlation_attached IS NOT TRUE
     OR v_request.status NOT IN ('sending', 'unknown')
     OR v_request.provider_reconcile_status <> 'pending' THEN
    RETURN 'unchanged';
  END IF;

  v_next_status := CASE
    WHEN v_request.provider_reconcile_attempts >= p_max_attempts THEN 'unresolved'
    ELSE 'pending'
  END;

  UPDATE public.manual_message_send_requests
  SET
    provider_reconcile_status = v_next_status,
    provider_reconcile_last_at = clock_timestamp(),
    provider_reconcile_last_error = NULLIF(btrim(COALESCE(p_error, '')), ''),
    updated_at = clock_timestamp()
  WHERE idempotency_key = p_idempotency_key;

  RETURN v_next_status;
END;
$$;

-- durable sent 행을 messages 원장으로 옮기는 단계도 outbox 잠금 아래 멱등 처리한다.
-- 이 함수에는 공급자 발송 경로가 없으며 sent 이전 상태는 절대 기록하지 않는다.
CREATE OR REPLACE FUNCTION public.record_manual_message_history(
  p_idempotency_key UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.manual_message_send_requests%ROWTYPE;
  v_message public.messages%ROWTYPE;
  v_inserted_count INTEGER := 0;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_request
  FROM public.manual_message_send_requests
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'unavailable';
  END IF;
  IF v_request.status NOT IN ('sent', 'recorded') THEN
    RETURN 'waiting_for_sent';
  END IF;

  INSERT INTO public.messages (
    applicant_id,
    applicant_phone,
    direction,
    body,
    status,
    sent_by,
    solapi_msg_id,
    job_id,
    client_request_id
  ) VALUES (
    v_request.applicant_id,
    v_request.applicant_phone,
    'outbound',
    v_request.body,
    'sent',
    v_request.sent_by,
    v_request.provider_message_id,
    v_request.job_id,
    v_request.idempotency_key
  )
  ON CONFLICT (client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  SELECT *
    INTO v_message
  FROM public.messages
  WHERE client_request_id = p_idempotency_key
  LIMIT 1;

  IF NOT FOUND
     OR v_message.applicant_id IS DISTINCT FROM v_request.applicant_id
     OR v_message.applicant_phone IS DISTINCT FROM v_request.applicant_phone
     OR v_message.direction IS DISTINCT FROM 'outbound'
     OR v_message.body IS DISTINCT FROM v_request.body
     OR v_message.sent_by IS DISTINCT FROM v_request.sent_by
     OR v_message.job_id IS DISTINCT FROM v_request.job_id THEN
    RETURN 'conflict';
  END IF;

  UPDATE public.manual_message_send_requests
  SET
    status = 'recorded',
    recorded_at = COALESCE(recorded_at, clock_timestamp()),
    last_error = NULL,
    updated_at = clock_timestamp()
  WHERE idempotency_key = p_idempotency_key;

  RETURN CASE WHEN v_inserted_count > 0 THEN 'recorded' ELSE 'deduped' END;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_manual_message_provider_reconciliation(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_manual_message_provider_reconciliation(UUID, INTEGER)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.record_manual_message_provider_match(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_message_provider_match(UUID, TEXT)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.record_manual_message_provider_miss(UUID, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_message_provider_miss(UUID, INTEGER, TEXT)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.record_manual_message_history(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_message_history(UUID)
  TO service_role;
