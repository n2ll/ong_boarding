-- branches 테이블에 슬롯별 정원(capacity) 추가.
-- 매니저가 지점관리 탭에서 슬롯별 정원을 자유롭게 편집할 수 있게 한다.
-- 기존 코드는 정원 2명으로 하드코딩되어 있어, 기본값도 2로 채워둔다.

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS slot_capacity JSONB
  DEFAULT '{"평일오전":2,"평일오후":2,"주말오전":2,"주말오후":2}'::jsonb;

-- 기존 row들이 NULL이면 디폴트로 채움
UPDATE branches
SET slot_capacity = '{"평일오전":2,"평일오후":2,"주말오전":2,"주말오후":2}'::jsonb
WHERE slot_capacity IS NULL;
