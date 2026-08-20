-- P1: 수동 SMS 성공 뒤 AI 중단·초안 처리의 원자성 및 stale replay 방어.
-- -----------------------------------------------------------------------------
-- 선행: 2026-08-manual-message-idempotency.sql
--
-- 외부 SMS 성공은 DB 트랜잭션에 넣을 수 없다. 대신 outbox가 발송 의도를 선점할 때
-- 후처리 대상을 스냅샷하고, 공급자 성공·messages 기록 뒤 이 함수가 outbox 행을 잠근
-- 한 트랜잭션 안에서 AI 중단 + 초안 처리 + completed 기록을 함께 커밋한다.
-- 응답 유실 replay는 completed 결과만 읽으며, 요청 뒤 갱신된 후보를 다시 멈추거나
-- 요청 뒤 만들어진 초안을 ignored 처리하지 않는다.

ALTER TABLE public.manual_message_send_requests
  ADD COLUMN IF NOT EXISTS postprocess_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS postprocess_is_copilot_draft BOOLEAN,
  ADD COLUMN IF NOT EXISTS postprocess_should_pause BOOLEAN,
  ADD COLUMN IF NOT EXISTS postprocess_target_candidate_id BIGINT,
  ADD COLUMN IF NOT EXISTS postprocess_target_candidate_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS postprocess_target_candidate_stage TEXT,
  ADD COLUMN IF NOT EXISTS postprocess_target_candidate_state JSONB,
  ADD COLUMN IF NOT EXISTS postprocess_paused_skipped TEXT,
  ADD COLUMN IF NOT EXISTS postprocess_paused_job_id BIGINT,
  ADD COLUMN IF NOT EXISTS postprocess_completed_at TIMESTAMPTZ;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'manual_message_send_requests_postprocess_status_check'
      AND conrelid = 'public.manual_message_send_requests'::regclass
  ) THEN
    ALTER TABLE public.manual_message_send_requests
      ADD CONSTRAINT manual_message_send_requests_postprocess_status_check
      CHECK (postprocess_status IN ('pending', 'completed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'manual_message_send_requests_paused_skipped_check'
      AND conrelid = 'public.manual_message_send_requests'::regclass
  ) THEN
    ALTER TABLE public.manual_message_send_requests
      ADD CONSTRAINT manual_message_send_requests_paused_skipped_check
      CHECK (postprocess_paused_skipped IS NULL OR postprocess_paused_skipped IN ('ambiguous', 'changed'));
  END IF;
END
$migration$;

COMMENT ON COLUMN public.manual_message_send_requests.postprocess_status IS
  'pending이면 후처리 재개 가능, completed이면 동일 key replay는 저장된 결과만 반환한다.';
COMMENT ON COLUMN public.manual_message_send_requests.postprocess_target_candidate_updated_at IS
  '발송 요청 선점 시점의 후보 버전. 이후 재개·수정된 AI 상태를 stale replay가 덮지 않는 비교값.';

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

  -- 코파일럿 여부도 outbox 선점 시점에 고정한다. replay 때 현재 draft를 다시 읽으면
  -- 그 사이 바뀐 상태를 과거 발송의 판단 근거로 오인할 수 있다.
  NEW.postprocess_is_copilot_draft := FALSE;
  IF NEW.draft_id IS NOT NULL THEN
    SELECT COALESCE(md.reasoning, '') LIKE '[코파일럿]%'
      INTO NEW.postprocess_is_copilot_draft
    FROM public.message_drafts AS md
    WHERE md.id::TEXT = NEW.draft_id
      AND md.applicant_id IS NOT DISTINCT FROM NEW.applicant_id
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

DROP TRIGGER IF EXISTS manual_message_send_requests_prepare_postprocess
  ON public.manual_message_send_requests;
CREATE TRIGGER manual_message_send_requests_prepare_postprocess
BEFORE INSERT ON public.manual_message_send_requests
FOR EACH ROW
EXECUTE FUNCTION public.prepare_manual_message_postprocess();

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
BEGIN
  -- 같은 논리 발송의 동시 replay는 여기서 직렬화된다. 첫 트랜잭션이 completed를
  -- 커밋하면 기다리던 요청은 어떤 부수효과도 재실행하지 않고 저장 결과만 읽는다.
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

  -- 공급자 성공만으로는 부족하다. messages 원장 복구까지 끝난 뒤에만 draft의
  -- used_message_id와 AI 상태를 함께 확정한다.
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
      -- 요청 뒤 AI가 재개되거나 후보 상태가 바뀌었다. 과거 발송 replay가 현재 상태를
      -- 다시 멈추지 않도록 이 요청의 후처리는 완료하되 pause만 보수적으로 건너뛴다.
      v_paused_skipped := 'changed';
    END IF;
  END IF;

  IF v_request.draft_id IS NOT NULL THEN
    -- 명시된 그 초안만, 발송 요청 당시 존재했고 아직 미처리인 경우에만 연결한다.
    UPDATE public.message_drafts AS md
    SET
      status = CASE WHEN v_request.draft_was_edited THEN 'edited' ELSE 'used' END,
      used_message_id = v_message.id,
      resolved_at = clock_timestamp()
    WHERE md.id::TEXT = v_request.draft_id
      AND md.applicant_id IS NOT DISTINCT FROM v_request.applicant_id
      AND md.created_at <= v_request.created_at
      AND md.status IN ('pending', 'need_info');
  ELSIF v_request.applicant_id IS NOT NULL THEN
    -- 직접 입력 발송은 요청 시점까지 존재한 미처리 초안만 무시한다. 이후 새 인입으로
    -- 생긴 초안은 이 과거 요청과 무관하므로 절대 건드리지 않는다.
    UPDATE public.message_drafts AS md
    SET
      status = 'ignored',
      resolved_at = clock_timestamp()
    WHERE md.applicant_id = v_request.applicant_id
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

REVOKE ALL ON FUNCTION public.prepare_manual_message_postprocess() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_manual_message_postprocess() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_manual_message_postprocess(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_manual_message_postprocess(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_manual_message_postprocess(UUID) TO service_role;
