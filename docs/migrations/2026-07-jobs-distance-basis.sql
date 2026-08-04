-- 2026-07-jobs-distance-basis.sql
-- M3 · 집결지 거리 반경 축 — 거리를 **어디서부터 재는지**를 공고마다 고를 수 있게 한다(사장님 결정 2026-07-29).
--
-- 왜 공고마다인가: 라인에 따라 집결지와 마지막 경유지가 붙어 있기도 하고 멀기도 하다.
--   실측(2026-07-29): 공고 32·34는 집결지=경유지라 두 기준이 동일(200/200, 186/186),
--   공고 33(용산·한남)은 13.8km 떨어져 15km 반경 대상이 **190명(집결지) ↔ 296명(둘 중 가까운 쪽)**.
--
-- 'nearest'(집결지·마지막 경유지 중 가까운 쪽)를 기본값으로 둔다 — '대기자에게 안내'의 조건 매칭이
-- 이미 그 기준이라, 기본값을 바꾸면 기존 대상이 조용히 좁아진다(공고 33: 296→190).
-- 'pickup'(집결지만)은 매일 출근하는 곳 기준이라 통근 부담과 지원자 화면의 '집에서 약 N km'와 일치한다.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS distance_basis text NOT NULL DEFAULT 'nearest';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_distance_basis_valid'
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_distance_basis_valid
      CHECK (distance_basis IN ('pickup', 'nearest'));
  END IF;
END $$;

COMMENT ON COLUMN jobs.distance_basis IS
  '거리 계산 기준: pickup=집결지만(통근 기준·지원자 화면 표시와 동일) / nearest=집결지·마지막 경유지 중 가까운 쪽(기본, 대기자 안내 조건 매칭과 동일).';
