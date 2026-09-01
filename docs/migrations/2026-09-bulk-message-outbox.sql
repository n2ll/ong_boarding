-- P0: 매니저 일괄 SMS의 수신자별 outbox, 동시 요청 가드, 무발송 복구.
-- -----------------------------------------------------------------------------
-- 한 화면 발송은 브라우저가 만든 batch UUID를 모든 50명 청크에 재사용한다. 서버는
-- batch UUID + 정규화 전화번호로 수신자 key를 결정하고, outbox를 선점한 한 요청만
-- 공급자 경계를 넘는다. 공급자 결과가 불명확하면 exact customFields 조회 외에는
-- 상태를 전진시키지 않으며 어떤 자동 재발송도 허용하지 않는다.

CREATE TABLE IF NOT EXISTS public.bulk_message_batches (
  request_id UUID PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  body TEXT NOT NULL,
  subject TEXT NOT NULL,
  effective_purpose TEXT NOT NULL DEFAULT '',
  job_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.bulk_message_send_requests (
  recipient_key UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES public.bulk_message_batches(request_id),
  recipient_fingerprint TEXT NOT NULL,
  applicant_id BIGINT,
  applicant_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  subject TEXT NOT NULL,
  effective_purpose TEXT NOT NULL DEFAULT '',
  job_id BIGINT,
  status TEXT NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending', 'unknown', 'failed', 'sent', 'recorded')),
  provider_message_id TEXT,
  last_error TEXT,
  provider_correlation_attached BOOLEAN NOT NULL DEFAULT TRUE,
  provider_reconcile_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (provider_reconcile_status IN ('pending', 'matched', 'unresolved')),
  provider_reconcile_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (provider_reconcile_attempts >= 0),
  provider_reconcile_claim_token UUID,
  provider_reconcile_claimed_until TIMESTAMPTZ,
  provider_reconcile_last_at TIMESTAMPTZ,
  provider_reconcile_last_error TEXT,
  provider_reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ,
  CHECK (applicant_phone ~ '^[0-9]{10,11}$')
);

-- batch id는 의도적으로 제외한다. 새 UUID를 만들어도 같은 전화번호·지원자·본문·목적·
-- 공고의 sending/unknown/sent 발송을 다시 선점할 수 없다.
CREATE UNIQUE INDEX IF NOT EXISTS bulk_message_send_requests_active_intent_uidx
  ON public.bulk_message_send_requests (applicant_phone, recipient_fingerprint)
  WHERE status IN ('sending', 'unknown', 'sent');

CREATE INDEX IF NOT EXISTS bulk_message_send_requests_sent_recovery_idx
  ON public.bulk_message_send_requests (created_at, recipient_key)
  WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS bulk_message_send_requests_provider_recovery_idx
  ON public.bulk_message_send_requests (created_at, recipient_key)
  WHERE provider_correlation_attached IS TRUE
    AND provider_reconcile_status = 'pending'
    AND status IN ('sending', 'unknown');

CREATE TABLE IF NOT EXISTS public.bulk_message_phone_guards (
  applicant_phone TEXT NOT NULL,
  scope TEXT NOT NULL
    CHECK (scope IN ('bulk_10m', 'job_notice_24h', 'new_job_7d')),
  owner_key UUID NOT NULL REFERENCES public.bulk_message_send_requests(recipient_key)
    ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (applicant_phone, scope),
  CHECK (applicant_phone ~ '^[0-9]{10,11}$')
);

ALTER TABLE public.bulk_message_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bulk_message_send_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bulk_message_phone_guards ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.bulk_message_batches FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.bulk_message_send_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.bulk_message_phone_guards FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bulk_message_batches TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bulk_message_send_requests TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bulk_message_phone_guards TO service_role;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS client_request_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS messages_client_request_id_uidx
  ON public.messages (client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_bulk_message_batch(
  p_request_id UUID,
  p_request_fingerprint TEXT,
  p_body TEXT,
  p_subject TEXT,
  p_effective_purpose TEXT,
  p_job_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch public.bulk_message_batches%ROWTYPE;
  v_inserted INTEGER := 0;
BEGIN
  IF p_request_id IS NULL
     OR NULLIF(BTRIM(COALESCE(p_request_fingerprint, '')), '') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_body, '')), '') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_subject, '')), '') IS NULL
     OR p_effective_purpose IS NULL THEN
    RAISE EXCEPTION 'invalid bulk message batch' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.bulk_message_batches (
    request_id,
    request_fingerprint,
    body,
    subject,
    effective_purpose,
    job_id
  ) VALUES (
    p_request_id,
    p_request_fingerprint,
    p_body,
    p_subject,
    p_effective_purpose,
    p_job_id
  )
  ON CONFLICT (request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 1 THEN
    RETURN JSONB_BUILD_OBJECT('outcome', 'claimed', 'reason', NULL);
  END IF;

  SELECT *
    INTO v_batch
  FROM public.bulk_message_batches
  WHERE request_id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN JSONB_BUILD_OBJECT('outcome', 'conflict', 'reason', 'batch_unavailable');
  END IF;

  IF v_batch.request_fingerprint IS DISTINCT FROM p_request_fingerprint
     OR v_batch.body IS DISTINCT FROM p_body
     OR v_batch.subject IS DISTINCT FROM p_subject
     OR v_batch.effective_purpose IS DISTINCT FROM p_effective_purpose
     OR v_batch.job_id IS DISTINCT FROM p_job_id THEN
    RETURN JSONB_BUILD_OBJECT('outcome', 'conflict', 'reason', 'batch_payload_mismatch');
  END IF;

  RETURN JSONB_BUILD_OBJECT('outcome', 'existing', 'reason', NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_bulk_message_recipient(
  p_batch_id UUID,
  p_applicant_id BIGINT,
  p_applicant_phone TEXT,
  p_personal_body TEXT,
  p_recipient_fingerprint TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch public.bulk_message_batches%ROWTYPE;
  v_existing public.bulk_message_send_requests%ROWTYPE;
  v_blocked public.bulk_message_send_requests%ROWTYPE;
  v_guard public.bulk_message_phone_guards%ROWTYPE;
  v_phone TEXT;
  v_recipient_key UUID;
  v_guard_reason TEXT;
BEGIN
  v_phone := REGEXP_REPLACE(COALESCE(p_applicant_phone, ''), '[^0-9]', '', 'g');
  IF p_batch_id IS NULL
     OR v_phone !~ '^[0-9]{10,11}$'
     OR NULLIF(BTRIM(COALESCE(p_personal_body, '')), '') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_recipient_fingerprint, '')), '') IS NULL THEN
    RAISE EXCEPTION 'invalid bulk message recipient' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_batch
  FROM public.bulk_message_batches
  WHERE request_id = p_batch_id;

  IF NOT FOUND THEN
    RETURN JSONB_BUILD_OBJECT(
      'outcome', 'conflict',
      'recipient_key', NULL,
      'status', NULL,
      'provider_message_id', NULL,
      'reason', 'batch_unavailable'
    );
  END IF;

  v_recipient_key := (
    MD5('bulk-send:' || p_batch_id::TEXT || ':' || v_phone)
  )::UUID;

  -- 서로 다른 batch의 동시 클릭도 한 전화번호에서 직렬화한다.
  PERFORM PG_ADVISORY_XACT_LOCK(
    PG_CATALOG.HASHTEXTEXTENDED('bulk-message-phone:' || v_phone, 0)
  );

  SELECT *
    INTO v_existing
  FROM public.bulk_message_send_requests
  WHERE recipient_key = v_recipient_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.batch_id IS DISTINCT FROM p_batch_id
       OR v_existing.applicant_id IS DISTINCT FROM p_applicant_id
       OR v_existing.applicant_phone IS DISTINCT FROM v_phone
       OR v_existing.body IS DISTINCT FROM p_personal_body
       OR v_existing.recipient_fingerprint IS DISTINCT FROM p_recipient_fingerprint THEN
      RETURN JSONB_BUILD_OBJECT(
        'outcome', 'conflict',
        'recipient_key', v_recipient_key,
        'status', v_existing.status,
        'provider_message_id', v_existing.provider_message_id,
        'reason', 'recipient_payload_mismatch'
      );
    END IF;

    RETURN JSONB_BUILD_OBJECT(
      'outcome', 'existing',
      'recipient_key', v_recipient_key,
      'status', v_existing.status,
      'provider_message_id', v_existing.provider_message_id,
      'reason', NULL
    );
  END IF;

  -- batch id를 바꿔도 같은 실제 발송 의도의 불명 상태는 재발송하지 않는다.
  SELECT *
    INTO v_blocked
  FROM public.bulk_message_send_requests
  WHERE applicant_phone = v_phone
    AND recipient_fingerprint = p_recipient_fingerprint
    AND status IN ('sending', 'unknown', 'sent')
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    RETURN JSONB_BUILD_OBJECT(
      'outcome', 'blocked',
      'recipient_key', v_blocked.recipient_key,
      'status', v_blocked.status,
      'provider_message_id', v_blocked.provider_message_id,
      'reason', 'same_intent_active'
    );
  END IF;

  DELETE FROM public.bulk_message_phone_guards
  WHERE applicant_phone = v_phone
    AND expires_at <= CLOCK_TIMESTAMP();

  SELECT *
    INTO v_guard
  FROM public.bulk_message_phone_guards
  WHERE applicant_phone = v_phone
    AND expires_at > CLOCK_TIMESTAMP()
    AND (
      scope = 'bulk_10m'
      OR (
        v_batch.effective_purpose IN ('campaign', 'job_closed', 'new_job')
        AND scope = 'job_notice_24h'
      )
      OR (
        v_batch.effective_purpose = 'new_job'
        AND scope = 'new_job_7d'
      )
    )
  ORDER BY
    CASE scope
      WHEN 'new_job_7d' THEN 1
      WHEN 'job_notice_24h' THEN 2
      ELSE 3
    END
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    v_guard_reason := CASE v_guard.scope
      WHEN 'new_job_7d' THEN 'recent_new_job'
      WHEN 'job_notice_24h' THEN 'recent_job_notice'
      ELSE 'recent_bulk'
    END;
    SELECT *
      INTO v_blocked
    FROM public.bulk_message_send_requests
    WHERE recipient_key = v_guard.owner_key;

    RETURN JSONB_BUILD_OBJECT(
      'outcome', 'blocked',
      'recipient_key', v_guard.owner_key,
      'status', v_blocked.status,
      'provider_message_id', v_blocked.provider_message_id,
      'reason', v_guard_reason
    );
  END IF;

  INSERT INTO public.bulk_message_send_requests (
    recipient_key,
    batch_id,
    recipient_fingerprint,
    applicant_id,
    applicant_phone,
    body,
    subject,
    effective_purpose,
    job_id,
    status,
    provider_correlation_attached,
    provider_reconcile_status
  ) VALUES (
    v_recipient_key,
    p_batch_id,
    p_recipient_fingerprint,
    p_applicant_id,
    v_phone,
    p_personal_body,
    v_batch.subject,
    v_batch.effective_purpose,
    v_batch.job_id,
    'sending',
    TRUE,
    'pending'
  );

  INSERT INTO public.bulk_message_phone_guards (
    applicant_phone, scope, owner_key, expires_at
  ) VALUES (
    v_phone, 'bulk_10m', v_recipient_key, CLOCK_TIMESTAMP() + INTERVAL '10 minutes'
  );

  IF v_batch.effective_purpose IN ('campaign', 'job_closed', 'new_job') THEN
    INSERT INTO public.bulk_message_phone_guards (
      applicant_phone, scope, owner_key, expires_at
    ) VALUES (
      v_phone, 'job_notice_24h', v_recipient_key, CLOCK_TIMESTAMP() + INTERVAL '24 hours'
    );
  END IF;

  IF v_batch.effective_purpose = 'new_job' THEN
    INSERT INTO public.bulk_message_phone_guards (
      applicant_phone, scope, owner_key, expires_at
    ) VALUES (
      v_phone, 'new_job_7d', v_recipient_key, CLOCK_TIMESTAMP() + INTERVAL '7 days'
    );
  END IF;

  RETURN JSONB_BUILD_OBJECT(
    'outcome', 'claimed',
    'recipient_key', v_recipient_key,
    'status', 'sending',
    'provider_message_id', NULL,
    'reason', NULL
  );
EXCEPTION
  WHEN unique_violation THEN
    -- advisory lock 밖의 직접 DB 쓰기까지 fail-closed로 흡수한다. 공급자는 호출되지 않는다.
    RETURN JSONB_BUILD_OBJECT(
      'outcome', 'blocked',
      'recipient_key', v_recipient_key,
      'status', NULL,
      'provider_message_id', NULL,
      'reason', 'concurrent_claim'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_bulk_message_provider_result(
  p_recipient_key UUID,
  p_result TEXT,
  p_provider_message_id TEXT DEFAULT NULL,
  p_error TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_phone TEXT;
  v_request public.bulk_message_send_requests%ROWTYPE;
BEGIN
  IF p_recipient_key IS NULL OR p_result NOT IN ('unknown', 'failed', 'sent') THEN
    RAISE EXCEPTION 'invalid bulk provider result' USING ERRCODE = '22023';
  END IF;

  SELECT applicant_phone
    INTO v_phone
  FROM public.bulk_message_send_requests
  WHERE recipient_key = p_recipient_key;
  IF NOT FOUND THEN
    RETURN 'unavailable';
  END IF;

  PERFORM PG_ADVISORY_XACT_LOCK(
    PG_CATALOG.HASHTEXTEXTENDED('bulk-message-phone:' || v_phone, 0)
  );

  SELECT *
    INTO v_request
  FROM public.bulk_message_send_requests
  WHERE recipient_key = p_recipient_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'unavailable';
  END IF;
  IF v_request.status = p_result
     AND (p_result <> 'sent' OR v_request.provider_message_id IS NOT DISTINCT FROM p_provider_message_id) THEN
    RETURN 'deduped';
  END IF;
  IF v_request.status <> 'sending' THEN
    RETURN 'unchanged';
  END IF;

  IF p_result = 'unknown' THEN
    UPDATE public.bulk_message_send_requests
    SET
      status = 'unknown',
      last_error = p_error,
      updated_at = CLOCK_TIMESTAMP()
    WHERE recipient_key = p_recipient_key;
  ELSIF p_result = 'failed' THEN
    UPDATE public.bulk_message_send_requests
    SET
      status = 'failed',
      last_error = p_error,
      provider_reconcile_status = 'unresolved',
      provider_reconcile_claim_token = NULL,
      provider_reconcile_claimed_until = NULL,
      provider_reconcile_last_error = p_error,
      updated_at = CLOCK_TIMESTAMP()
    WHERE recipient_key = p_recipient_key;

    -- 등록 실패가 명확한 경우에만 새 사용자 의도가 전화번호를 다시 선점할 수 있다.
    DELETE FROM public.bulk_message_phone_guards
    WHERE owner_key = p_recipient_key;
  ELSE
    UPDATE public.bulk_message_send_requests
    SET
      status = 'sent',
      provider_message_id = p_provider_message_id,
      last_error = NULL,
      sent_at = COALESCE(sent_at, CLOCK_TIMESTAMP()),
      provider_reconcile_status = 'matched',
      provider_reconcile_claim_token = NULL,
      provider_reconcile_claimed_until = NULL,
      provider_reconciled_at = CLOCK_TIMESTAMP(),
      provider_reconcile_last_error = NULL,
      updated_at = CLOCK_TIMESTAMP()
    WHERE recipient_key = p_recipient_key;

    UPDATE public.bulk_message_phone_guards
    SET
      expires_at = GREATEST(
        expires_at,
        CLOCK_TIMESTAMP() + CASE scope
          WHEN 'new_job_7d' THEN INTERVAL '7 days'
          WHEN 'job_notice_24h' THEN INTERVAL '24 hours'
          ELSE INTERVAL '10 minutes'
        END
      ),
      updated_at = CLOCK_TIMESTAMP()
    WHERE owner_key = p_recipient_key;
  END IF;

  RETURN 'recorded';
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_bulk_message_send(
  p_recipient_key UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_phone TEXT;
  v_request public.bulk_message_send_requests%ROWTYPE;
  v_message public.messages%ROWTYPE;
  v_message_client_request_id UUID;
BEGIN
  IF p_recipient_key IS NULL THEN
    RAISE EXCEPTION 'bulk recipient key is required' USING ERRCODE = '22023';
  END IF;

  SELECT applicant_phone
    INTO v_phone
  FROM public.bulk_message_send_requests
  WHERE recipient_key = p_recipient_key;
  IF NOT FOUND THEN
    RETURN 'unavailable';
  END IF;

  PERFORM PG_ADVISORY_XACT_LOCK(
    PG_CATALOG.HASHTEXTEXTENDED('bulk-message-phone:' || v_phone, 0)
  );

  SELECT *
    INTO v_request
  FROM public.bulk_message_send_requests
  WHERE recipient_key = p_recipient_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'unavailable';
  END IF;
  IF v_request.status = 'recorded' THEN
    RETURN 'deduped';
  END IF;
  IF v_request.status <> 'sent' THEN
    RETURN 'waiting';
  END IF;

  v_message_client_request_id := (
    MD5('bulk-message:' || p_recipient_key::TEXT)
  )::UUID;

  INSERT INTO public.messages (
    applicant_id,
    applicant_phone,
    direction,
    body,
    status,
    sent_by,
    solapi_msg_id,
    message_type,
    job_id,
    client_request_id
  ) VALUES (
    v_request.applicant_id,
    v_request.applicant_phone,
    'outbound',
    v_request.body,
    'sent',
    'system-bulk',
    v_request.provider_message_id,
    'sms',
    v_request.job_id,
    v_message_client_request_id
  )
  ON CONFLICT (client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING;

  SELECT *
    INTO v_message
  FROM public.messages
  WHERE client_request_id = v_message_client_request_id
  LIMIT 1;

  IF NOT FOUND
     OR v_message.applicant_id IS DISTINCT FROM v_request.applicant_id
     OR v_message.applicant_phone IS DISTINCT FROM v_request.applicant_phone
     OR v_message.direction IS DISTINCT FROM 'outbound'
     OR v_message.body IS DISTINCT FROM v_request.body
     OR v_message.status IS DISTINCT FROM 'sent'
     OR v_message.sent_by IS DISTINCT FROM 'system-bulk'
     OR v_message.solapi_msg_id IS DISTINCT FROM v_request.provider_message_id
     OR v_message.message_type IS DISTINCT FROM 'sms'
     OR v_message.job_id IS DISTINCT FROM v_request.job_id THEN
    RETURN 'conflict';
  END IF;

  IF v_request.applicant_id IS NOT NULL THEN
    INSERT INTO public.pool_events (applicant_id, job_id, event_type, meta)
    VALUES (
      v_request.applicant_id,
      v_request.job_id,
      'ping_sent',
      JSONB_STRIP_NULLS(JSONB_BUILD_OBJECT(
        'source', 'bulk',
        'has_link', POSITION('/p/' IN v_request.body) > 0,
        'purpose', NULLIF(v_request.effective_purpose, ''),
        'job_id', v_request.job_id,
        'bulk_recipient_key', p_recipient_key
      ))
    );

    IF v_request.effective_purpose = 'job_closed' AND v_request.job_id IS NOT NULL THEN
      INSERT INTO public.pool_events (applicant_id, job_id, event_type, meta)
      VALUES (
        v_request.applicant_id,
        v_request.job_id,
        'waitlist_notice',
        JSONB_BUILD_OBJECT(
          'trigger', 'job_closed',
          'bulk_recipient_key', p_recipient_key
        )
      );
    END IF;
  END IF;

  UPDATE public.bulk_message_phone_guards
  SET
    expires_at = GREATEST(
      expires_at,
      COALESCE(v_request.sent_at, CLOCK_TIMESTAMP()) + CASE scope
        WHEN 'new_job_7d' THEN INTERVAL '7 days'
        WHEN 'job_notice_24h' THEN INTERVAL '24 hours'
        ELSE INTERVAL '10 minutes'
      END
    ),
    updated_at = CLOCK_TIMESTAMP()
  WHERE owner_key = p_recipient_key;

  UPDATE public.bulk_message_send_requests
  SET
    status = 'recorded',
    recorded_at = COALESCE(recorded_at, CLOCK_TIMESTAMP()),
    last_error = NULL,
    updated_at = CLOCK_TIMESTAMP()
  WHERE recipient_key = p_recipient_key;

  RETURN 'recorded';
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_bulk_message_provider_reconciliation(
  p_recipient_key UUID,
  p_max_attempts INTEGER,
  p_claim_token UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.bulk_message_send_requests%ROWTYPE;
BEGIN
  IF p_recipient_key IS NULL
     OR p_claim_token IS NULL
     OR p_max_attempts < 1
     OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'invalid bulk provider reconciliation claim' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_request
  FROM public.bulk_message_send_requests
  WHERE recipient_key = p_recipient_key
  FOR UPDATE;

  IF NOT FOUND
     OR v_request.provider_correlation_attached IS NOT TRUE
     OR v_request.status NOT IN ('sending', 'unknown')
     OR v_request.provider_reconcile_status <> 'pending' THEN
    RETURN 'unavailable';
  END IF;

  IF v_request.provider_reconcile_claim_token IS NOT NULL
     AND v_request.provider_reconcile_claimed_until > CLOCK_TIMESTAMP() THEN
    RETURN 'leased';
  END IF;

  IF v_request.provider_reconcile_attempts >= p_max_attempts THEN
    UPDATE public.bulk_message_send_requests
    SET
      provider_reconcile_status = 'unresolved',
      provider_reconcile_claim_token = NULL,
      provider_reconcile_claimed_until = NULL,
      provider_reconcile_last_at = CLOCK_TIMESTAMP(),
      provider_reconcile_last_error = COALESCE(
        provider_reconcile_last_error,
        'provider reconciliation attempts exhausted'
      ),
      updated_at = CLOCK_TIMESTAMP()
    WHERE recipient_key = p_recipient_key;
    RETURN 'exhausted';
  END IF;

  UPDATE public.bulk_message_send_requests
  SET
    provider_reconcile_attempts = provider_reconcile_attempts + 1,
    provider_reconcile_claim_token = p_claim_token,
    provider_reconcile_claimed_until = CLOCK_TIMESTAMP() + INTERVAL '90 seconds',
    provider_reconcile_last_at = CLOCK_TIMESTAMP(),
    provider_reconcile_last_error = NULL,
    updated_at = CLOCK_TIMESTAMP()
  WHERE recipient_key = p_recipient_key;

  RETURN 'claimed';
END;
$$;

CREATE OR REPLACE FUNCTION public.record_bulk_message_provider_match(
  p_recipient_key UUID,
  p_provider_message_id TEXT,
  p_claim_token UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_phone TEXT;
  v_request public.bulk_message_send_requests%ROWTYPE;
BEGIN
  IF p_recipient_key IS NULL
     OR p_claim_token IS NULL
     OR NULLIF(BTRIM(COALESCE(p_provider_message_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'invalid bulk provider reconciliation match' USING ERRCODE = '22023';
  END IF;

  SELECT applicant_phone
    INTO v_phone
  FROM public.bulk_message_send_requests
  WHERE recipient_key = p_recipient_key;
  IF NOT FOUND THEN
    RETURN 'unavailable';
  END IF;

  PERFORM PG_ADVISORY_XACT_LOCK(
    PG_CATALOG.HASHTEXTEXTENDED('bulk-message-phone:' || v_phone, 0)
  );

  SELECT *
    INTO v_request
  FROM public.bulk_message_send_requests
  WHERE recipient_key = p_recipient_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'unavailable';
  END IF;
  IF v_request.status IN ('sent', 'recorded')
     AND v_request.provider_message_id IS NOT DISTINCT FROM p_provider_message_id THEN
    RETURN 'deduped';
  END IF;
  IF v_request.provider_reconcile_claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN 'stale_claim';
  END IF;
  IF v_request.provider_correlation_attached IS NOT TRUE
     OR v_request.provider_reconcile_status <> 'pending'
     OR v_request.status NOT IN ('sending', 'unknown') THEN
    RETURN 'unchanged';
  END IF;

  UPDATE public.bulk_message_send_requests
  SET
    status = 'sent',
    provider_message_id = p_provider_message_id,
    sent_at = COALESCE(sent_at, CLOCK_TIMESTAMP()),
    last_error = NULL,
    provider_reconcile_status = 'matched',
    provider_reconcile_claim_token = NULL,
    provider_reconcile_claimed_until = NULL,
    provider_reconciled_at = CLOCK_TIMESTAMP(),
    provider_reconcile_last_error = NULL,
    updated_at = CLOCK_TIMESTAMP()
  WHERE recipient_key = p_recipient_key;

  UPDATE public.bulk_message_phone_guards
  SET
    expires_at = GREATEST(
      expires_at,
      CLOCK_TIMESTAMP() + CASE scope
        WHEN 'new_job_7d' THEN INTERVAL '7 days'
        WHEN 'job_notice_24h' THEN INTERVAL '24 hours'
        ELSE INTERVAL '10 minutes'
      END
    ),
    updated_at = CLOCK_TIMESTAMP()
  WHERE owner_key = p_recipient_key;

  RETURN 'matched';
END;
$$;

CREATE OR REPLACE FUNCTION public.record_bulk_message_provider_miss(
  p_recipient_key UUID,
  p_max_attempts INTEGER,
  p_claim_token UUID,
  p_error TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.bulk_message_send_requests%ROWTYPE;
  v_next_status TEXT;
BEGIN
  IF p_recipient_key IS NULL
     OR p_claim_token IS NULL
     OR p_max_attempts < 1
     OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'invalid bulk provider reconciliation miss' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_request
  FROM public.bulk_message_send_requests
  WHERE recipient_key = p_recipient_key
  FOR UPDATE;

  IF NOT FOUND
     OR v_request.provider_correlation_attached IS NOT TRUE
     OR v_request.status NOT IN ('sending', 'unknown')
     OR v_request.provider_reconcile_status <> 'pending' THEN
    RETURN 'unchanged';
  END IF;
  IF v_request.provider_reconcile_claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN 'stale_claim';
  END IF;

  v_next_status := CASE
    WHEN v_request.provider_reconcile_attempts >= p_max_attempts THEN 'unresolved'
    ELSE 'pending'
  END;

  UPDATE public.bulk_message_send_requests
  SET
    provider_reconcile_status = v_next_status,
    provider_reconcile_claim_token = NULL,
    provider_reconcile_claimed_until = NULL,
    provider_reconcile_last_at = CLOCK_TIMESTAMP(),
    provider_reconcile_last_error = NULLIF(BTRIM(COALESCE(p_error, '')), ''),
    updated_at = CLOCK_TIMESTAMP()
  WHERE recipient_key = p_recipient_key;

  RETURN v_next_status;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_bulk_message_batch(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_bulk_message_batch(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.claim_bulk_message_recipient(UUID, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_bulk_message_recipient(UUID, BIGINT, TEXT, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.record_bulk_message_provider_result(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_bulk_message_provider_result(UUID, TEXT, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.finalize_bulk_message_send(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_bulk_message_send(UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION public.claim_bulk_message_provider_reconciliation(UUID, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_bulk_message_provider_reconciliation(UUID, INTEGER, UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION public.record_bulk_message_provider_match(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_bulk_message_provider_match(UUID, TEXT, UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION public.record_bulk_message_provider_miss(UUID, INTEGER, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_bulk_message_provider_miss(UUID, INTEGER, UUID, TEXT) TO service_role;

COMMENT ON TABLE public.bulk_message_send_requests IS
  '일괄 SMS 수신자별 outbox. 공급자 결과 불명 상태는 exact correlation 외에는 자동 전진·재발송하지 않는다.';
COMMENT ON COLUMN public.bulk_message_send_requests.recipient_fingerprint IS
  'batch UUID를 제외한 전화번호·지원자·개인화 본문·제목·목적·공고 지문. 새 batch UUID 재발송 우회를 막는다.';
COMMENT ON TABLE public.bulk_message_phone_guards IS
  '전화번호 단위 10분/공고 안내 24시간/신규 공고 7일 원자 중복 가드. declared failure만 조기 해제한다.';
