-- 공고 ↔ 긴급 건(SOS) 연결 (재컨택 운영 동선, 2026-07-09)
-- ----------------------------------------------------------------
-- 배경: 긴급 건(sos_requests)에서 '공고로 만들기'로 넘어와 등록한 공고가
--   어느 긴급 건에서 파생됐는지 영속 기록이 없었다(프리필 후 URL 파라미터로만 전달, 저장 안 됨).
--   sos_request_id를 jobs에 두어 파생 관계를 보관한다. (자동 해결 로그 연동은 범위 밖 — 연결만.)
--
-- nullable: 일반 공고는 SOS 파생이 아니므로 NULL이 정상.
-- ON DELETE SET NULL: 긴급 건이 지워져도 공고 자체는 유지.
-- 재실행 안전: 멱등 (IF NOT EXISTS).

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sos_request_id BIGINT
  REFERENCES sos_requests (id) ON DELETE SET NULL;

-- 특정 긴급 건에서 파생된 공고 역조회용
CREATE INDEX IF NOT EXISTS jobs_sos_request_id_idx
  ON jobs (sos_request_id);
