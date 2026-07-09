-- 원지원 시각(applied_at) 승격 (Phase C 재컨택 파일럿, 2026-07-09)
-- ----------------------------------------------------------------
-- 배경: created_at은 Airtable 일괄 임포트 시각(전원 2026-06)이라 실제 지원 시점과 무관하다.
--   실제 Tally 제출 시각은 airtable_raw JSON 안('Submitted at' ISO, 또는 '제출일' 날짜)에만 있어
--   목록 API(LIST_COLUMNS)·파이프라인 정렬에서 쓸 수 없었다. 재컨택 문구가 코호트 신선도로
--   A안(전체)/B안(최근 6개월)로 갈리는데 정작 "원지원 최신순" 정렬·"6개월 이내" 필터를 못 했다.
--   applied_at을 정규 컬럼으로 승격해 목록·정렬·코호트 필터의 단일 소스로 삼는다.
--
-- 백필: 'Submitted at'(ISO 타임스탬프) 우선, 없으면 '제출일'(날짜). 잘못된 포맷은 건너뜀(regex 가드).
-- 재실행 안전: 멱등(applied_at IS NULL 가드 + IF NOT EXISTS).

ALTER TABLE applicants ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;

UPDATE applicants
SET applied_at = (airtable_raw->>'Submitted at')::timestamptz
WHERE applied_at IS NULL
  AND airtable_raw->>'Submitted at' ~ '^\d{4}-\d{2}-\d{2}';

UPDATE applicants
SET applied_at = (airtable_raw->>'제출일')::timestamptz
WHERE applied_at IS NULL
  AND airtable_raw->>'제출일' ~ '^\d{4}-\d{2}-\d{2}';

CREATE INDEX IF NOT EXISTS applicants_applied_at_idx
  ON applicants (applied_at DESC NULLS LAST);
