-- job_candidates.engage_queued_at — pull '관심 있어요' 야간 클릭 자동 응대 예약 표시.
--
-- KST 21시~익일 08시 사이의 관심 클릭은 즉시 첫 문자를 보내지 않고 이 컬럼에 예약 시각을 기록한다.
-- 다음날 아침 9시(KST) cron(/api/admin/cron/engage-queued)이 값이 있는 후보를 모아
-- 3단 모드·가드(수신거부/진행 중/중복/충원)를 재검사한 뒤 발송하고 NULL로 클리어한다.
-- 발송 실패 건은 값을 유지해 다음날 재시도한다.
ALTER TABLE job_candidates
  ADD COLUMN IF NOT EXISTS engage_queued_at TIMESTAMPTZ;

COMMENT ON COLUMN job_candidates.engage_queued_at IS
  'pull 관심 클릭 야간(KST 21~08시) 자동 응대 예약 — 아침 9시 cron(engage-queued)이 발송 후 클리어';
