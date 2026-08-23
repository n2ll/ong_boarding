-- P0: 멀티-잡 수동 문자에서 AI 초안의 공고 귀속을 고정한다.
-- -----------------------------------------------------------------------------
-- 선행: 2026-08-manual-message-postprocess.sql
--
-- 한 지원자에게 여러 공고가 열려 있을 때 applicant_id만으로 초안을 조회·종료하면
-- A 공고 답장이 B 공고 초안을 사용/무시할 수 있다. 초안 생성 시 job_id를 기록하고,
-- 기존 초안은 생성 뒤 messages.job_id가 재분류됐을 수 있어 NULL을 유지한다.
-- 새 코드가 생성 시점의 권위 있는 job_id만 기록하며, 특정 공고의 직접 답장은 NULL 초안을
-- 자동 종료하지 않는다.

BEGIN;

ALTER TABLE public.message_drafts
  ADD COLUMN IF NOT EXISTS job_id BIGINT,
  ADD COLUMN IF NOT EXISTS send_claim_key UUID,
  ADD COLUMN IF NOT EXISTS send_claimed_at TIMESTAMPTZ;

-- 초안 하나를 서로 다른 요청 키가 동시에 승인하지 못하게 DB에서 선점한다.
-- 공급자가 실패를 명시한 요청은 새 키로 다시 시도할 수 있어 index에서 제외한다.
CREATE UNIQUE INDEX IF NOT EXISTS manual_message_send_requests_draft_claim_idx
  ON public.manual_message_send_requests (draft_id)
  WHERE draft_id IS NOT NULL AND status <> 'failed';

CREATE UNIQUE INDEX IF NOT EXISTS message_drafts_send_claim_key_idx
  ON public.message_drafts (send_claim_key)
  WHERE send_claim_key IS NOT NULL;

COMMENT ON COLUMN public.message_drafts.job_id IS
  '초안을 생성할 때 사용한 공고 컨텍스트. NULL은 공고 귀속을 안전하게 판정하지 못한 초안이다.';
COMMENT ON COLUMN public.message_drafts.send_claim_key IS
  '발송 outbox가 원자적으로 선점한 요청 UUID. 발송·무시·직접 답장의 동시 처리를 막는다.';
COMMENT ON COLUMN public.message_drafts.send_claimed_at IS
  'send_claim_key가 선점된 시각. 공급자 결과가 불명확하면 재발송하지 않고 복구 근거로 보존한다.';

CREATE OR REPLACE FUNCTION public.prepare_manual_message_postprocess()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active_job_count BIGINT := 0;
BEGIN
  NEW.postprocess_status := 'pending';
  NEW.postprocess_completed_at := NULL;
  NEW.postprocess_paused_job_id := NULL;
  NEW.postprocess_paused_skipped := NULL;
  NEW.postprocess_target_candidate_id := NULL;
  NEW.postprocess_target_candidate_updated_at := NULL;
  NEW.postprocess_target_candidate_stage := NULL;
  NEW.postprocess_target_candidate_state := NULL;

  -- 신규 key는 outbox INSERT와 같은 트랜잭션에서 미처리 초안을 먼저 선점한다.
  -- 이 행 잠금이 ignore/direct-input 정리와 직렬화되어, 문자 발송과 '무시됨' 감사 상태가
  -- 서로 엇갈리는 경쟁 조건을 막는다. INSERT가 뒤에서 실패하면 이 UPDATE도 함께 롤백된다.
  -- 동일 key replay는 이미 존재하는 outbox를 복구해야 하므로 재선점하지 않는다.
  IF NEW.draft_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.manual_message_send_requests AS existing_request
       WHERE existing_request.idempotency_key = NEW.idempotency_key
     ) THEN
    UPDATE public.message_drafts AS md
    SET
      send_claim_key = NEW.idempotency_key,
      send_claimed_at = COALESCE(md.send_claimed_at, clock_timestamp())
    WHERE md.id::TEXT = NEW.draft_id
      AND md.applicant_id IS NOT DISTINCT FROM NEW.applicant_id
      AND md.job_id IS NOT DISTINCT FROM NEW.job_id
      AND md.status IN ('pending', 'need_info')
      AND (md.send_claim_key IS NULL OR md.send_claim_key = NEW.idempotency_key);

    IF NOT FOUND THEN
      IF EXISTS (
        SELECT 1
        FROM public.message_drafts AS claimed_draft
        WHERE claimed_draft.id::TEXT = NEW.draft_id
          AND claimed_draft.applicant_id IS NOT DISTINCT FROM NEW.applicant_id
          AND claimed_draft.job_id IS NOT DISTINCT FROM NEW.job_id
          AND claimed_draft.status IN ('pending', 'need_info')
          AND claimed_draft.send_claim_key IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'manual message draft already claimed'
          USING ERRCODE = '23505';
      END IF;
      RAISE EXCEPTION 'manual message draft scope mismatch or resolved'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.postprocess_is_copilot_draft := FALSE;
  IF NEW.draft_id IS NOT NULL THEN
    SELECT COALESCE(md.reasoning, '') LIKE '[코파일럿]%'
      INTO NEW.postprocess_is_copilot_draft
    FROM public.message_drafts AS md
    WHERE md.id::TEXT = NEW.draft_id
      AND md.applicant_id IS NOT DISTINCT FROM NEW.applicant_id
      AND md.job_id IS NOT DISTINCT FROM NEW.job_id
      AND md.created_at <= NEW.created_at
    ORDER BY md.created_at DESC
    LIMIT 1;
    NEW.postprocess_is_copilot_draft := COALESCE(NEW.postprocess_is_copilot_draft, FALSE);
  END IF;

  NEW.postprocess_should_pause :=
    NEW.applicant_id IS NOT NULL
    AND NEW.postprocess_is_copilot_draft IS FALSE
    AND NEW.sent_by <> ALL (ARRAY[
      'agent',
      'agent-practice',
      'system-auto',
      'danggeun-start',
      'baemin-start',
      'danggeun-practice-start',
      'danggeun-recommend'
    ]::TEXT[]);

  IF NEW.postprocess_should_pause THEN
    IF NEW.job_id IS NOT NULL THEN
      SELECT jc.id, jc.updated_at, jc.agent_stage, jc.agent_state
        INTO NEW.postprocess_target_candidate_id,
             NEW.postprocess_target_candidate_updated_at,
             NEW.postprocess_target_candidate_stage,
             NEW.postprocess_target_candidate_state
      FROM public.job_candidates AS jc
      WHERE jc.applicant_id = NEW.applicant_id
        AND jc.job_id = NEW.job_id
        AND jc.agent_stage IN ('exploration', 'screening', 'onboarding', 'active')
        AND jc.created_at <= NEW.created_at
      ORDER BY jc.created_at DESC
      LIMIT 1;
    ELSE
      SELECT COUNT(DISTINCT jc.job_id)
        INTO v_active_job_count
      FROM public.job_candidates AS jc
      WHERE jc.applicant_id = NEW.applicant_id
        AND jc.agent_stage IN ('exploration', 'screening', 'onboarding', 'active')
        AND jc.created_at <= NEW.created_at;

      IF v_active_job_count > 1 THEN
        NEW.postprocess_paused_skipped := 'ambiguous';
      ELSIF v_active_job_count = 1 THEN
        SELECT jc.id, jc.updated_at, jc.agent_stage, jc.agent_state
          INTO NEW.postprocess_target_candidate_id,
               NEW.postprocess_target_candidate_updated_at,
               NEW.postprocess_target_candidate_stage,
               NEW.postprocess_target_candidate_state
        FROM public.job_candidates AS jc
        WHERE jc.applicant_id = NEW.applicant_id
          AND jc.agent_stage IN ('exploration', 'screening', 'onboarding', 'active')
          AND jc.created_at <= NEW.created_at
        ORDER BY jc.created_at DESC
        LIMIT 1;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_manual_message_postprocess(
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.manual_message_send_requests%ROWTYPE;
  v_message public.messages%ROWTYPE;
  v_paused_skipped TEXT;
  v_paused_job_id BIGINT;
  v_draft_updated_count INTEGER := 0;
BEGIN
  SELECT *
    INTO v_request
  FROM public.manual_message_send_requests
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'missing');
  END IF;

  IF v_request.postprocess_status = 'completed' THEN
    RETURN jsonb_build_object(
      'outcome', 'completed',
      'paused_skipped', v_request.postprocess_paused_skipped,
      'paused_job_id', v_request.postprocess_paused_job_id
    );
  END IF;

  IF v_request.status <> 'recorded' THEN
    RETURN jsonb_build_object('outcome', 'waiting_for_record');
  END IF;

  SELECT *
    INTO v_message
  FROM public.messages
  WHERE client_request_id = p_idempotency_key
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'waiting_for_record');
  END IF;

  v_paused_skipped := v_request.postprocess_paused_skipped;

  IF v_request.postprocess_should_pause IS TRUE
     AND v_request.postprocess_target_candidate_id IS NOT NULL THEN
    UPDATE public.job_candidates AS jc
    SET
      agent_stage = 'paused',
      paused_reason = '매니저 직접 응답 — 자동 전환',
      agent_state = COALESCE(jc.agent_state, '{}'::JSONB)
        || jsonb_build_object(
          'meta',
          CASE
            WHEN jsonb_typeof(jc.agent_state -> 'meta') = 'object'
              THEN jc.agent_state -> 'meta'
            ELSE '{}'::JSONB
          END
          || jsonb_build_object(
            'paused_from_stage', jc.agent_stage,
            'paused_at', clock_timestamp(),
            'paused_by', 'manager-send'
          )
        )
    WHERE jc.id = v_request.postprocess_target_candidate_id
      AND jc.agent_stage IN ('exploration', 'screening', 'onboarding', 'active')
      AND jc.agent_stage IS NOT DISTINCT FROM v_request.postprocess_target_candidate_stage
      AND jc.agent_state IS NOT DISTINCT FROM v_request.postprocess_target_candidate_state
      AND jc.updated_at = v_request.postprocess_target_candidate_updated_at
      AND jc.updated_at <= v_request.created_at
    RETURNING jc.job_id INTO v_paused_job_id;

    IF NOT FOUND THEN
      v_paused_skipped := 'changed';
    END IF;
  END IF;

  IF v_request.draft_id IS NOT NULL THEN
    UPDATE public.message_drafts AS md
    SET
      status = CASE WHEN v_request.draft_was_edited THEN 'edited' ELSE 'used' END,
      used_message_id = v_message.id,
      resolved_at = clock_timestamp(),
      send_claim_key = NULL,
      send_claimed_at = NULL
    WHERE md.id::TEXT = v_request.draft_id
      AND md.applicant_id IS NOT DISTINCT FROM v_request.applicant_id
      AND md.job_id IS NOT DISTINCT FROM v_request.job_id
      AND md.send_claim_key = v_request.idempotency_key
      AND md.created_at <= v_request.created_at
      AND md.status IN ('pending', 'need_info');
    GET DIAGNOSTICS v_draft_updated_count = ROW_COUNT;
    IF v_draft_updated_count <> 1 THEN
      RAISE EXCEPTION 'manual message draft completion invariant failed'
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_request.applicant_id IS NOT NULL
     AND v_request.job_id IS NOT NULL THEN
    -- 직접 입력은 명시된 공고의 과거 초안만 정리한다. NULL 공고는 귀속을 추론하지 않는다.
    UPDATE public.message_drafts AS md
    SET
      status = 'ignored',
      resolved_at = clock_timestamp()
    WHERE md.applicant_id = v_request.applicant_id
      AND md.job_id = v_request.job_id
      AND md.send_claim_key IS NULL
      AND md.created_at <= v_request.created_at
      AND md.status IN ('pending', 'need_info');
  END IF;

  UPDATE public.manual_message_send_requests
  SET
    postprocess_status = 'completed',
    postprocess_paused_skipped = v_paused_skipped,
    postprocess_paused_job_id = v_paused_job_id,
    postprocess_completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object(
    'outcome', 'processed',
    'paused_skipped', v_paused_skipped,
    'paused_job_id', v_paused_job_id
  );
END;
$$;

-- DB-first rolling 구간의 구버전 PATCH도 claimed 초안을 ignored/used로 바꾸지 못하게 한다.
-- 정상 완료는 status 변경과 claim 해제를 같은 UPDATE에서 하므로 통과한다.
CREATE OR REPLACE FUNCTION public.guard_claimed_message_draft_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.send_claim_key IS NOT NULL
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.send_claim_key IS NOT NULL THEN
    RAISE EXCEPTION 'claimed message draft status cannot change before claim release'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS message_drafts_guard_claimed_status
  ON public.message_drafts;
CREATE TRIGGER message_drafts_guard_claimed_status
BEFORE UPDATE OF status ON public.message_drafts
FOR EACH ROW
EXECUTE FUNCTION public.guard_claimed_message_draft_status_change();

-- 구버전 애플리케이션이 outbox만 failed로 바꾸더라도 같은 트랜잭션에서 claim을 푼다.
CREATE OR REPLACE FUNCTION public.release_failed_manual_message_draft_claim()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'failed'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.draft_id IS NOT NULL THEN
    UPDATE public.message_drafts AS md
    SET
      send_claim_key = NULL,
      send_claimed_at = NULL
    WHERE md.id::TEXT = NEW.draft_id
      AND md.applicant_id IS NOT DISTINCT FROM NEW.applicant_id
      AND md.job_id IS NOT DISTINCT FROM NEW.job_id
      AND md.send_claim_key = NEW.idempotency_key
      AND md.status IN ('pending', 'need_info');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS manual_message_send_requests_release_failed_draft
  ON public.manual_message_send_requests;
CREATE TRIGGER manual_message_send_requests_release_failed_draft
AFTER UPDATE OF status ON public.manual_message_send_requests
FOR EACH ROW
EXECUTE FUNCTION public.release_failed_manual_message_draft_claim();

-- 공급자가 실패를 명시한 경우에만 outbox 실패 확정과 초안 선점 해제를 한 트랜잭션으로 묶는다.
-- DB 확정에 실패하면 선점을 유지해 안전하게 교착시키며, 애플리케이션은 새 발송을 권하지 않는다.
CREATE OR REPLACE FUNCTION public.fail_manual_message_send_request(
  p_idempotency_key UUID,
  p_error TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.manual_message_send_requests%ROWTYPE;
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
    RETURN 'missing';
  END IF;
  IF v_request.status = 'failed' THEN
    RETURN 'failed';
  END IF;
  IF v_request.status <> 'sending' THEN
    RETURN 'unchanged';
  END IF;

  UPDATE public.manual_message_send_requests
  SET
    status = 'failed',
    last_error = p_error,
    updated_at = clock_timestamp()
  WHERE idempotency_key = p_idempotency_key
    AND status = 'sending';

  RETURN 'failed';
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_manual_message_postprocess() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_manual_message_postprocess() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_claimed_message_draft_status_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_claimed_message_draft_status_change() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.release_failed_manual_message_draft_claim() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_failed_manual_message_draft_claim() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_manual_message_postprocess(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_manual_message_postprocess(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_manual_message_postprocess(UUID) TO service_role;
REVOKE EXECUTE ON FUNCTION public.fail_manual_message_send_request(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fail_manual_message_send_request(UUID, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_manual_message_send_request(UUID, TEXT) TO service_role;

COMMIT;
