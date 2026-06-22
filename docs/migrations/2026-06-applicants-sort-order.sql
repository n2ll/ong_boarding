-- 확정슬롯(PPC) 표에서 지원자 순서를 매니저가 직접 조정할 수 있도록 sort_order 컬럼 추가.
--
-- - default = id 로 시드 (기존 입력 순서 유지)
-- - 정렬은 (sort_order ASC, id ASC) — 같은 그룹(지점 + 상태) 안에서만 비교가 의미 있다.

ALTER TABLE applicants
  ADD COLUMN IF NOT EXISTS sort_order INTEGER;

UPDATE applicants
   SET sort_order = id
 WHERE sort_order IS NULL;

CREATE INDEX IF NOT EXISTS idx_applicants_branch_status_sortorder
  ON applicants (confirmed_branch, status, sort_order);
