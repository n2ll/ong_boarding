-- 백필: 기존 source='danggeun'/'danggeun_practice' applicants 중
-- job_candidates row가 없는 사람들에게 exploration 단계로 자동 생성.
--
-- 배경: 신영식님 같은 케이스 — apply 폼이나 초기 등록 코드가 job_candidates를
-- 만들지 않아 router가 dispatch 못 했던 후보들. 이제 모두 AI 자동 응대 흐름에 올림.
--
-- 한 번만 실행. 이미 row가 있는 후보는 건드리지 않음.

INSERT INTO job_candidates (job_id, applicant_id, agent_stage, agent_state)
SELECT
  (SELECT id FROM jobs WHERE title = '__danggeun_system__' LIMIT 1),
  a.id,
  'exploration',
  '{}'::jsonb
FROM applicants a
WHERE a.source IN ('danggeun', 'danggeun_practice')
  AND NOT EXISTS (
    SELECT 1 FROM job_candidates jc WHERE jc.applicant_id = a.id
  );

-- 백필 결과 확인용 — 실행 후 영향 받은 row 수 확인하고 싶으면 별도로:
-- SELECT count(*) FROM job_candidates jc
-- JOIN applicants a ON a.id = jc.applicant_id
-- WHERE a.source IN ('danggeun','danggeun_practice');
