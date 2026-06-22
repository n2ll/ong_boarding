-- job_candidates.agent_stage CHECK 제약을 코드가 사용하는 값들로 갱신.
-- 에러: "new row for relation \"job_candidates\" violates check constraint \"chk_jc_stage\""
--
-- 기존 제약에 'exploration'이 누락되어 있어 신규 후보 등록 시 silent fail.
-- 코드가 쓰는 모든 stage 값을 허용하도록 재정의.

ALTER TABLE job_candidates
  DROP CONSTRAINT IF EXISTS chk_jc_stage;

ALTER TABLE job_candidates
  ADD CONSTRAINT chk_jc_stage
  CHECK (
    agent_stage IS NULL
    OR agent_stage IN (
      'exploration',
      'screening',
      'onboarding',
      'active',
      'paused',
      'abort'
    )
  );
