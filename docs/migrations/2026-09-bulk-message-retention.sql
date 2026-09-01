-- 일괄 SMS outbox의 평문 PII를 30일 뒤 제거하되, 재실행을 막는 키·지문·상태는
-- tombstone으로 유지한다. 공급자 결과가 불명확하거나 후처리 중인 행은 정리하지 않는다.

ALTER TABLE public.bulk_message_batches
  ADD COLUMN IF NOT EXISTS redacted_at TIMESTAMPTZ;

ALTER TABLE public.bulk_message_send_requests
  ADD COLUMN IF NOT EXISTS redacted_at TIMESTAMPTZ;

ALTER TABLE public.bulk_message_batches
  ALTER COLUMN body DROP NOT NULL,
  ALTER COLUMN subject DROP NOT NULL;

ALTER TABLE public.bulk_message_send_requests
  ALTER COLUMN applicant_phone DROP NOT NULL,
  ALTER COLUMN body DROP NOT NULL,
  ALTER COLUMN subject DROP NOT NULL;

ALTER TABLE public.bulk_message_send_requests
  DROP CONSTRAINT IF EXISTS bulk_message_send_requests_applicant_phone_check;
ALTER TABLE public.bulk_message_send_requests
  ADD CONSTRAINT bulk_message_send_requests_applicant_phone_check
  CHECK (applicant_phone IS NULL OR applicant_phone ~ '^[0-9]{10,11}$');

ALTER TABLE public.bulk_message_batches
  DROP CONSTRAINT IF EXISTS bulk_message_batches_redaction_shape_check;
ALTER TABLE public.bulk_message_batches
  ADD CONSTRAINT bulk_message_batches_redaction_shape_check
  CHECK (
    (redacted_at IS NULL AND body IS NOT NULL AND subject IS NOT NULL)
    OR (redacted_at IS NOT NULL AND body IS NULL AND subject IS NULL)
  );

ALTER TABLE public.bulk_message_send_requests
  DROP CONSTRAINT IF EXISTS bulk_message_send_requests_redaction_shape_check;
ALTER TABLE public.bulk_message_send_requests
  ADD CONSTRAINT bulk_message_send_requests_redaction_shape_check
  CHECK (
    redacted_at IS NULL
    OR (
      status IN ('recorded', 'failed')
      AND applicant_id IS NULL
      AND applicant_phone IS NULL
      AND body IS NULL
      AND subject IS NULL
      AND provider_message_id IS NULL
      AND last_error IS NULL
      AND provider_reconcile_last_error IS NULL
    )
  );

ALTER TABLE public.bulk_message_send_requests
  DROP CONSTRAINT IF EXISTS bulk_message_send_requests_active_plaintext_check;
ALTER TABLE public.bulk_message_send_requests
  ADD CONSTRAINT bulk_message_send_requests_active_plaintext_check
  CHECK (
    status NOT IN ('sending', 'unknown', 'sent')
    OR (
      status IN ('sending', 'unknown', 'sent')
      AND redacted_at IS NULL
      AND applicant_phone IS NOT NULL
      AND body IS NOT NULL
      AND subject IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS bulk_message_recorded_retention_idx
  ON public.bulk_message_send_requests (recorded_at, recipient_key)
  WHERE status = 'recorded' AND redacted_at IS NULL;

CREATE INDEX IF NOT EXISTS bulk_message_failed_retention_idx
  ON public.bulk_message_send_requests (updated_at, recipient_key)
  WHERE status = 'failed' AND redacted_at IS NULL;

CREATE INDEX IF NOT EXISTS bulk_message_batch_retention_idx
  ON public.bulk_message_batches (created_at, request_id)
  WHERE redacted_at IS NULL;

CREATE INDEX IF NOT EXISTS bulk_message_recipient_batch_retention_idx
  ON public.bulk_message_send_requests (batch_id, recipient_key)
  WHERE redacted_at IS NULL;

CREATE INDEX IF NOT EXISTS bulk_message_attention_idx
  ON public.bulk_message_send_requests (created_at, recipient_key)
  WHERE status IN ('sending', 'unknown', 'sent');

-- 평문이 남아있는 동안에는 기존의 완전 일치 검사를 유지한다. 정리된 batch는
-- request_fingerprint만으로 원 요청의 replay를 인식하고 다른 payload는 계속 막는다.
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
     OR (
       v_batch.redacted_at IS NULL
       AND (
         v_batch.body IS DISTINCT FROM p_body
         OR v_batch.subject IS DISTINCT FROM p_subject
         OR v_batch.effective_purpose IS DISTINCT FROM p_effective_purpose
         OR v_batch.job_id IS DISTINCT FROM p_job_id
       )
     ) THEN
    RETURN JSONB_BUILD_OBJECT('outcome', 'conflict', 'reason', 'batch_payload_mismatch');
  END IF;

  RETURN JSONB_BUILD_OBJECT('outcome', 'existing', 'reason', NULL);
END;
$$;

-- claim과 정리는 batch -> recipient 순서로 잠근다. 정리된 batch의 기존 수신자는
-- terminal tombstone으로 dedupe하되, 과거 batch에 새 수신자를 추가하는 것은 막는다.
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
  WHERE request_id = p_batch_id
  FOR SHARE;

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
       OR v_existing.recipient_fingerprint IS DISTINCT FROM p_recipient_fingerprint
       OR (
         v_existing.redacted_at IS NULL
         AND (
           v_existing.applicant_id IS DISTINCT FROM p_applicant_id
           OR v_existing.applicant_phone IS DISTINCT FROM v_phone
           OR v_existing.body IS DISTINCT FROM p_personal_body
         )
       ) THEN
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

  IF v_batch.redacted_at IS NOT NULL THEN
    RETURN JSONB_BUILD_OBJECT(
      'outcome', 'conflict',
      'recipient_key', v_recipient_key,
      'status', NULL,
      'provider_message_id', NULL,
      'reason', 'batch_retired'
    );
  END IF;

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
    RETURN JSONB_BUILD_OBJECT(
      'outcome', 'blocked',
      'recipient_key', v_recipient_key,
      'status', NULL,
      'provider_message_id', NULL,
      'reason', 'concurrent_claim'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.redact_bulk_message_terminal_data(
  p_batch_limit INTEGER DEFAULT 25,
  p_recipient_limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := CLOCK_TIMESTAMP();
  v_batch_id UUID;
  v_recipient_key UUID;
  v_changed INTEGER := 0;
  v_expired_guards INTEGER := 0;
  v_redacted_recipients INTEGER := 0;
  v_redacted_batches INTEGER := 0;
BEGIN
  IF p_batch_limit IS NULL OR p_batch_limit < 1 OR p_batch_limit > 100
     OR p_recipient_limit IS NULL OR p_recipient_limit < 1 OR p_recipient_limit > 500 THEN
    RAISE EXCEPTION 'invalid bulk message retention limit' USING ERRCODE = '22023';
  END IF;

  -- batch를 먼저 잠가 claim_bulk_message_recipient와 잠금 순서를 통일한다.
  FOR v_batch_id IN
    SELECT b.request_id
    FROM public.bulk_message_batches AS b
    WHERE b.redacted_at IS NULL
      AND (
        EXISTS (
          SELECT 1
          FROM public.bulk_message_send_requests AS s
          WHERE s.batch_id = b.request_id
            AND s.redacted_at IS NULL
            AND (
              (
                s.status = 'recorded'
                AND COALESCE(s.recorded_at, s.updated_at) < v_now - INTERVAL '30 days'
              )
              OR (
                s.status = 'failed'
                AND s.updated_at < v_now - INTERVAL '30 days'
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.bulk_message_phone_guards AS active_guard
              WHERE active_guard.owner_key = s.recipient_key
                AND active_guard.expires_at > v_now
            )
        )
        OR (
          b.created_at < v_now - INTERVAL '30 days'
          AND NOT EXISTS (
            SELECT 1
            FROM public.bulk_message_send_requests AS pending_child
            WHERE pending_child.batch_id = b.request_id
              AND pending_child.redacted_at IS NULL
          )
        )
      )
    ORDER BY b.created_at ASC, b.request_id ASC
    LIMIT p_batch_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_redacted_recipients >= p_recipient_limit THEN
      EXIT;
    END IF;

    FOR v_recipient_key IN
      SELECT s.recipient_key
      FROM public.bulk_message_send_requests AS s
      WHERE s.batch_id = v_batch_id
        AND s.redacted_at IS NULL
        AND (
          (
            s.status = 'recorded'
            AND COALESCE(s.recorded_at, s.updated_at) < v_now - INTERVAL '30 days'
          )
          OR (
            s.status = 'failed'
            AND s.updated_at < v_now - INTERVAL '30 days'
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.bulk_message_phone_guards AS active_guard
          WHERE active_guard.owner_key = s.recipient_key
            AND active_guard.expires_at > v_now
        )
      ORDER BY COALESCE(s.recorded_at, s.updated_at) ASC, s.recipient_key ASC
      LIMIT p_recipient_limit - v_redacted_recipients
      FOR UPDATE SKIP LOCKED
    LOOP
      WITH expired AS (
        DELETE FROM public.bulk_message_phone_guards
        WHERE owner_key = v_recipient_key
          AND expires_at <= v_now
        RETURNING 1
      )
      SELECT COUNT(*)::INTEGER INTO v_changed FROM expired;
      v_expired_guards := v_expired_guards + v_changed;

      IF NOT EXISTS (
        SELECT 1
        FROM public.bulk_message_phone_guards
        WHERE owner_key = v_recipient_key
      ) THEN
        UPDATE public.bulk_message_send_requests
        SET
          applicant_id = NULL,
          applicant_phone = NULL,
          body = NULL,
          subject = NULL,
          provider_message_id = NULL,
          last_error = NULL,
          provider_reconcile_claim_token = NULL,
          provider_reconcile_claimed_until = NULL,
          provider_reconcile_last_error = NULL,
          redacted_at = CLOCK_TIMESTAMP(),
          updated_at = CLOCK_TIMESTAMP()
        WHERE recipient_key = v_recipient_key
          AND redacted_at IS NULL
          AND status IN ('recorded', 'failed');
        GET DIAGNOSTICS v_changed = ROW_COUNT;
        v_redacted_recipients := v_redacted_recipients + v_changed;
      END IF;
    END LOOP;

    UPDATE public.bulk_message_batches AS b
    SET
      body = NULL,
      subject = NULL,
      redacted_at = CLOCK_TIMESTAMP(),
      updated_at = CLOCK_TIMESTAMP()
    WHERE b.request_id = v_batch_id
      AND b.redacted_at IS NULL
      AND b.created_at < v_now - INTERVAL '30 days'
      AND NOT EXISTS (
        SELECT 1
        FROM public.bulk_message_send_requests AS remaining_child
        WHERE remaining_child.batch_id = b.request_id
          AND remaining_child.redacted_at IS NULL
      );
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_redacted_batches := v_redacted_batches + v_changed;
  END LOOP;

  RETURN JSONB_BUILD_OBJECT(
    'expired_guards', v_expired_guards,
    'redacted_recipients', v_redacted_recipients,
    'redacted_batches', v_redacted_batches
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_bulk_message_batch(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_bulk_message_batch(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.claim_bulk_message_recipient(UUID, BIGINT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_bulk_message_recipient(UUID, BIGINT, TEXT, TEXT, TEXT)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.redact_bulk_message_terminal_data(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redact_bulk_message_terminal_data(INTEGER, INTEGER) TO service_role;

COMMENT ON COLUMN public.bulk_message_send_requests.redacted_at IS
  'terminal 상태 30일 뒤 outbox 중복 PII를 제거한 시각. 키·지문·상태는 재발송 방지 tombstone으로 유지한다.';
COMMENT ON COLUMN public.bulk_message_batches.redacted_at IS
  '모든 수신자 tombstone 정리 뒤 batch 평문 본문·제목을 제거한 시각.';
