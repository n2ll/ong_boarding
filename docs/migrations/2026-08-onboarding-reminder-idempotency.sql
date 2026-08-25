-- 온보딩 리마인더 SMS 선점·결과를 agent_state JSONB 밖에 보존한다.
-- agent router/transition은 agent_state 전체를 갱신할 수 있으므로 JSONB 안의 claim은
-- 동시 응답 처리에 덮여 중복 발송될 수 있다. 전용 scalar 컬럼의 조건부 UPDATE 승자만 발송한다.

ALTER TABLE public.job_candidates
  ADD COLUMN IF NOT EXISTS onboarding_reminder_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_reminder_claim_id UUID,
  ADD COLUMN IF NOT EXISTS onboarding_reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_reminder_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_reminder_failure_kind TEXT;

DO $$
BEGIN
  ALTER TABLE public.job_candidates
    ADD CONSTRAINT job_candidates_onboarding_reminder_claim_pair_check
    CHECK (
      (onboarding_reminder_claimed_at IS NULL)
      = (onboarding_reminder_claim_id IS NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE public.job_candidates
    ADD CONSTRAINT job_candidates_onboarding_reminder_failure_kind_check
    CHECK (
      onboarding_reminder_failure_kind IS NULL
      OR onboarding_reminder_failure_kind IN ('declared', 'unknown')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS job_candidates_onboarding_reminder_claim_id_key
  ON public.job_candidates (onboarding_reminder_claim_id)
  WHERE onboarding_reminder_claim_id IS NOT NULL;

COMMENT ON COLUMN public.job_candidates.onboarding_reminder_claimed_at IS
  '온보딩 리마인더 공급자 호출 전 선점 시각. NULL 조건부 UPDATE 승자만 발송한다.';
COMMENT ON COLUMN public.job_candidates.onboarding_reminder_claim_id IS
  'SOLAPI customFields에도 싣는 리마인더 발송 상관관계 UUID.';
COMMENT ON COLUMN public.job_candidates.onboarding_reminder_sent_at IS
  '공급자 등록 성공 시각. 기존 agent_state.meta 값은 읽기 호환용으로만 유지한다.';
COMMENT ON COLUMN public.job_candidates.onboarding_reminder_failed_at IS
  '공급자 호출 실패 또는 결과 불명 시각. 자동 재발송하지 않는다.';
COMMENT ON COLUMN public.job_candidates.onboarding_reminder_failure_kind IS
  'declared=공급자 등록 거절 확정, unknown=등록 여부 불명. 둘 다 자동 재발송 금지.';
