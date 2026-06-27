-- 지오코딩 정확도 플래그.
-- ----------------------------------------------------------------
--   geo_precision : 'exact'  = 전체 주소(동/지번)로 좌표 확보
--                   'approx' = 전체 주소 실패 → 시/군/구 단위 폴백(구 중심점, 거리 점수 근사)
--                   NULL     = 좌표 없음 또는 미분류
--
-- 시/군/구 폴백 지오코딩으로 인재풀 좌표 커버리지를 끌어올리되, 근사 좌표를 구분해
-- 추천 거리 점수/지도뷰에서 정확도를 표시할 수 있게 한다.

ALTER TABLE applicants
  ADD COLUMN IF NOT EXISTS geo_precision TEXT;

-- 이미 좌표가 있는 행은 전체 주소로 잡힌 것이므로 exact로 표기.
UPDATE applicants SET geo_precision = 'exact'
 WHERE lat IS NOT NULL AND geo_precision IS NULL;
