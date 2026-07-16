-- 2026-07-tms-active-cache.sql
-- 옹고잉 TMS(배송 운영, AWS RDS) '활동 중 배송원' 신호 캐시 — 외부 DB 연동 Phase 1.
--
-- tms-sync cron이 전화번호 매칭으로 판정해 채운다. 값은 3-상태다:
--   NULL  = 미확인 (아직 sync 전이거나 TMS 미연동)
--   true  = TMS에서 최근/예정 배차(schedule) 보유 = 활동 중
--   false = 확인했으나 활동 신호 없음
-- ⚠️ NULL을 false로 뭉개지 말 것 — 미확인을 '비활동'으로 취급하면 실제로 뛰고 있는
--    시니어 기사에게 콜드 재컨택 문자가 나갈 수 있다(옹보딩에서 가장 피해야 할 사고).
-- 저장은 파생값만 — 개인정보/정산금액/원본 배차행은 반입하지 않는다.

ALTER TABLE applicants
  ADD COLUMN IF NOT EXISTS tms_active_signal boolean,
  ADD COLUMN IF NOT EXISTS tms_active_reason text,
  ADD COLUMN IF NOT EXISTS tms_active_checked_at timestamptz;

COMMENT ON COLUMN applicants.tms_active_signal IS 'TMS 활동 중 배송원 여부(NULL=미확인/true/false). tms-sync cron이 갱신.';
COMMENT ON COLUMN applicants.tms_active_reason IS 'TMS 활동 판정 근거 마커(예: recent_schedule). 비활동/미확인이면 NULL.';
COMMENT ON COLUMN applicants.tms_active_checked_at IS '우리가 TMS와 마지막으로 대조한 시각(신선도 표시용).';
