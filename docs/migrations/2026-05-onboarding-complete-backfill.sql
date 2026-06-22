-- 온보딩 완료 일괄 마이그레이션 (배포 후 1회 실행)
-- ------------------------------------------------------------------------
-- 배경: 신규 흐름에서는 배민 아이디·차량번호 둘 다 수신되면 자동으로
--   agent_stage='active' + applicants.status='온보딩 완료'로 전환되지만,
--   기존 데이터는 stage='onboarding'에 머물러 있음. 이걸 한 번에 정리.
--
-- 적용 범위:
--   - job_candidates.agent_stage='onboarding'
--   - agent_state.onboarding.배민_아이디_수신 = true
--   - agent_state.onboarding.차량번호_수신   = true
--
-- 효과:
--   - 해당 job_candidates → agent_stage='active', activated_at(없으면 now())
--   - 해당 applicants → status='온보딩 완료'
--     (이미 '확정'/'이탈'/'부적합'이면 매니저 판단이라 건드리지 않음)

BEGIN;

-- 1) job_candidates: onboarding → active
UPDATE job_candidates
SET
  agent_stage = 'active',
  activated_at = COALESCE(activated_at, now())
WHERE agent_stage = 'onboarding'
  AND (agent_state->'onboarding'->>'배민_아이디_수신') = 'true'
  AND (agent_state->'onboarding'->>'차량번호_수신') = 'true';

-- 2) applicants: 위에서 active로 옮겨진 후보의 status를 '온보딩 완료'로
--    (이미 '확정'·'이탈'·'부적합'이면 건드리지 않음 — 매니저가 손댔다는 신호)
UPDATE applicants a
SET status = '온보딩 완료'
FROM job_candidates jc
WHERE jc.applicant_id = a.id
  AND jc.agent_stage = 'active'
  AND a.status NOT IN ('확정', '이탈', '부적합')
  AND (jc.agent_state->'onboarding'->>'배민_아이디_수신') = 'true'
  AND (jc.agent_state->'onboarding'->>'차량번호_수신') = 'true';

COMMIT;

-- 적용 결과 확인 (선택)
-- SELECT a.name, a.status, jc.agent_stage
-- FROM applicants a
-- JOIN job_candidates jc ON jc.applicant_id = a.id
-- WHERE jc.agent_stage = 'active'
-- ORDER BY jc.activated_at DESC NULLS LAST;
