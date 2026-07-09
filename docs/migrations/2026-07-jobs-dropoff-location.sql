-- 공고 마지막 경유지(배송 종료 지점) — 파이프라인 거리 정렬용 (Phase B)
-- ----------------------------------------------------------------
-- 배경:
--   배송 라인은 상차지(pickup_*)에서 시작해 여러 곳을 배송한 뒤 '마지막 경유지'에서 끝난다.
--   지원자에겐 시작점뿐 아니라 끝나는 위치도 중요하므로, 공고에 마지막 경유지 좌표를 두고
--   파이프라인 거리 정렬이 후보↔{상차지, 마지막 경유지} 중 최소 거리로 순위를 매기게 한다.
--   컬럼 타입·nullable은 pickup_address/pickup_lat/pickup_lng와 동일하게 미러링한다.
--
-- 마지막 경유지 = 배송 종료 지점. 거리 정렬용(주소 지오코딩 → lat/lng).
-- 재실행 안전: 멱등 (IF NOT EXISTS).

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS dropoff_address TEXT,        -- 마지막 경유지(배송 종료 지점) 주소
  ADD COLUMN IF NOT EXISTS dropoff_lat NUMERIC,         -- 지오코딩 위도 (거리 정렬용, pickup_lat와 동일 타입)
  ADD COLUMN IF NOT EXISTS dropoff_lng NUMERIC;         -- 지오코딩 경도 (거리 정렬용, pickup_lng와 동일 타입)
