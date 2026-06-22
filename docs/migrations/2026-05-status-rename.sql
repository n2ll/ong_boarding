-- 진행상태(applicants.status)를 당근 단계명과 통일.
--   서류심사       → 스크리닝
--   스크리닝 완료  → 온보딩
--   확정/이탈/부적합은 그대로.
--
-- 운영 데이터에 한 번만 실행하면 됩니다.
UPDATE applicants SET status = '스크리닝' WHERE status = '서류심사';
UPDATE applicants SET status = '온보딩' WHERE status = '스크리닝 완료';
