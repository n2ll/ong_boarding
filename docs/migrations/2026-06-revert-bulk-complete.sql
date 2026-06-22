-- 직전 bulk-complete 일괄 마이그레이션 정정 (배포 후 1회 실행).
-- ----------------------------------------------------------------
-- 직전 SQL이 자동 상태(스크리닝 전/중/완료) 당근·배민 후보 전부를 '스크리닝 완료'로 박았는데,
-- 사실은 **진짜 온보딩까지 완료해서 AI가 마무리 멘트를 보낸 후보**만 '스크리닝 완료'여야 함.
-- 그 외는 '스크리닝 중'으로 되돌리고 agent_stage·agent_state도 함께 정리.
--
-- 진짜 완료 식별 기준:
--   - messages에 outbound + sent_by='agent'/'agent-practice'이면서
--     본문에 '곧 담당 매니저', '곧 매니저', '확인되었습니다' 중 하나 포함
--   = AI가 마무리 멘트를 보낸 흔적 (= 아이디 수신했음).
--
-- 매니저가 이미 손댄 상태(확정인력/대기자/부적합)는 건드리지 않음.

BEGIN;

-- 1) 가짜 완료 후보들의 applicants.status → '스크리닝 중'
-- (진짜 완료자 = 마무리 메시지 흔적이 있는 케이스. 그 외만 되돌림)
UPDATE applicants
SET status = '스크리닝 중'
WHERE source IN ('danggeun', 'baemin', 'danggeun_practice')
  AND status = '스크리닝 완료'
  AND id NOT IN (
    SELECT DISTINCT m.applicant_id
    FROM messages m
    WHERE m.direction = 'outbound'
      AND m.sent_by IN ('agent', 'agent-practice')
      AND m.applicant_id IS NOT NULL
      AND (
        m.body LIKE '%곧 담당 매니저%'
        OR m.body LIKE '%곧 매니저%'
        OR m.body LIKE '%확인되었습니다%'
      )
  );

-- 2) 그 후보들의 job_candidates → agent_stage='screening', activated_at null,
--    agent_state 기본 자동-true 3항목만 (그 외는 false), onboarding 초기화
UPDATE job_candidates jc
SET
  agent_stage = 'screening',
  activated_at = NULL,
  agent_state = jsonb_set(
    jsonb_set(
      COALESCE(agent_state, '{}'::jsonb),
      '{screening}',
      '{
        "자차_재확인": false,
        "프로모션_종료가능성_안내": true,
        "정산주기_안내": true,
        "공휴일_업무여부_확인": false,
        "본인명의_정산_문제없음": false,
        "업무시간_체계_이해": true,
        "지원자_질문_해소": false
      }'::jsonb,
      true
    ),
    '{onboarding}',
    '{}'::jsonb,
    true
  )
FROM applicants a
WHERE jc.applicant_id = a.id
  AND a.source IN ('danggeun', 'baemin', 'danggeun_practice')
  AND a.status = '스크리닝 중'         -- 위에서 방금 되돌린 케이스만
  AND jc.agent_stage = 'active';        -- bulk-complete가 active로 박은 케이스만

-- 3) 평일 슬롯(work_hours에 '주말' 없음)이면 공휴일 항목 자동-true로 보강
UPDATE job_candidates jc
SET agent_state = jsonb_set(
  agent_state,
  '{screening,공휴일_업무여부_확인}',
  'true'::jsonb,
  true
)
FROM applicants a
WHERE jc.applicant_id = a.id
  AND a.source IN ('danggeun', 'baemin', 'danggeun_practice')
  AND a.status = '스크리닝 중'
  AND jc.agent_stage = 'screening'
  AND (a.work_hours IS NULL OR a.work_hours = '미확인' OR a.work_hours NOT LIKE '%주말%');

COMMIT;

-- 점검용 (선택) — 진짜 완료자만 보기
-- SELECT a.id, a.name, a.phone
-- FROM applicants a
-- WHERE a.source IN ('danggeun','baemin','danggeun_practice')
--   AND a.id IN (
--     SELECT DISTINCT m.applicant_id FROM messages m
--     WHERE m.direction='outbound' AND m.sent_by IN ('agent','agent-practice')
--       AND m.applicant_id IS NOT NULL
--       AND (m.body LIKE '%곧 담당 매니저%' OR m.body LIKE '%곧 매니저%' OR m.body LIKE '%확인되었습니다%')
--   );

-- 적용 결과 확인 (선택)
-- SELECT a.name, a.source, a.status, jc.agent_stage
-- FROM applicants a
-- LEFT JOIN job_candidates jc ON jc.applicant_id = a.id
-- WHERE a.source IN ('danggeun','baemin','danggeun_practice')
-- ORDER BY a.created_at DESC;
