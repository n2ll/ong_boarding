-- prompt_examples 테이블에 'system_message' 카테고리 추가.
-- 시스템이 자동 발송하는 운영 메시지(시작 멘트, 접수 안내 등)를 매니저가
-- 톤가이드처럼 편집할 수 있게 한다. apply route 등 서버 측에서도 조회.

ALTER TABLE prompt_examples
  DROP CONSTRAINT IF EXISTS prompt_examples_category_check;

ALTER TABLE prompt_examples
  ADD CONSTRAINT prompt_examples_category_check
  CHECK (category IN ('conversation', 'screening', 'facts', 'system_message'));

-- 사용 규약:
-- category='system_message' + title='danggeun_start' → 당근 유입 후보 시작 멘트
-- category='system_message' + title='apply_received'  → apply 폼 접수 안내
