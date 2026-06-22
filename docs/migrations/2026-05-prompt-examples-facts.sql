-- prompt_examples 테이블에 'facts' 카테고리 허용.
-- AI 참고자료(지점별 시급/구인 상태/정책 등 사실 정보)를 같은 테이블에서 관리.

ALTER TABLE prompt_examples
  DROP CONSTRAINT IF EXISTS prompt_examples_category_check;

ALTER TABLE prompt_examples
  ADD CONSTRAINT prompt_examples_category_check
  CHECK (category IN ('conversation', 'screening', 'facts'));
