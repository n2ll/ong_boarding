-- 관심 표시 처리 상태 (Phase C 파일럿, 2026-07-08)
-- ----------------------------------------------------------------
-- 배경: pull 페이지에서 지원자가 '관심 있어요'/'바로 가능'을 누르면 job_candidates가
--   agent_stage=NULL로 생성되고 Slack 알림 + 후보 보드 노출까지는 됐으나, 매니저가
--   "이 관심을 처리했는지"를 표시할 방법이 없어 홈 처리 큐를 만들 수 없었다.
--   contacted_at으로 처리 여부를 명시적으로 기록(agent_stage 오버로드 회피).
--
--   홈 '관심 표시 처리 대기' 큐 = 실공고 job_candidates 중
--     agent_stage IS NULL AND contacted_at IS NULL AND 지원자 status NOT IN
--     (확정인력/부적합/이탈). 매니저가 [컨택 완료]/[보류] 시 contacted_at 기록되어 큐에서 빠짐.
--
-- 재실행 안전: 멱등.

ALTER TABLE job_candidates ADD COLUMN IF NOT EXISTS contacted_at TIMESTAMPTZ;
