-- 기존 당근/배민 후보 일괄 정리 (배포 후 1회 실행).
-- ----------------------------------------------------------------
-- 1) 옛 status 값을 새 6종으로 매핑 (이미 실행했다면 멱등)
-- 2) source='danggeun'/'baemin'/'danggeun_practice' 후보들 중 자동 상태(스크리닝 전/중/완료)인 케이스를
--    '스크리닝 완료' + agent_stage='active'로 일괄 마무리. 체크리스트도 다 채움.
--    매니저가 이미 확정인력/대기자/부적합 설정한 후보는 건드리지 않음.

BEGIN;

-- ─── 1. 옛 status 매핑 ─────────────────────────────────────────────
UPDATE applicants SET status = '스크리닝 중'   WHERE status = '스크리닝';
UPDATE applicants SET status = '스크리닝 완료' WHERE status IN ('온보딩', '온보딩 완료');
UPDATE applicants SET status = '확정인력'      WHERE status = '확정';
UPDATE applicants SET status = '부적합'        WHERE status = '이탈';
UPDATE applicants
   SET status = '스크리닝 전'
 WHERE status IS NULL
    OR status NOT IN ('스크리닝 전', '스크리닝 중', '스크리닝 완료', '확정인력', '대기자', '부적합');

-- ─── 2. 당근/배민 자동상태 후보 → 스크리닝 완료 일괄 마무리 ─────
-- 2a) applicants.status
UPDATE applicants
   SET status = '스크리닝 완료'
 WHERE source IN ('danggeun', 'baemin', 'danggeun_practice')
   AND status IN ('스크리닝 전', '스크리닝 중', '스크리닝 완료');

-- 2b) job_candidates.agent_state·agent_stage·activated_at
UPDATE job_candidates jc
SET
  agent_stage = CASE
    WHEN agent_stage IN ('exploration', 'screening', 'onboarding') THEN 'active'
    ELSE agent_stage
  END,
  activated_at = COALESCE(activated_at, now()),
  agent_state = jsonb_set(
    jsonb_set(
      COALESCE(agent_state, '{}'::jsonb),
      '{screening}',
      '{"자차_재확인":true,"프로모션_종료가능성_안내":true,"정산주기_안내":true,"공휴일_업무여부_확인":true,"본인명의_정산_문제없음":true,"업무시간_체계_이해":true,"지원자_질문_해소":true}'::jsonb,
      true
    ),
    '{onboarding}',
    '{"앱설치_교육_안내발송됨":true,"배민_아이디_수신":true,"만남장소_안내발송됨":true}'::jsonb,
    true
  )
FROM applicants a
WHERE jc.applicant_id = a.id
  AND a.source IN ('danggeun', 'baemin', 'danggeun_practice')
  AND a.status = '스크리닝 완료'
  AND jc.agent_stage NOT IN ('paused', 'abort');

COMMIT;
