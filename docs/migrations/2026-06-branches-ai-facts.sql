-- 지점별 AI 참고 정보를 branches 테이블에 직접 저장.
-- ----------------------------------------------------------------
-- 매니저가 [지점관리] 탭에서 지점 행마다 자유 텍스트로 작성.
-- 응대 시 그 지원자의 1지망(branch1) 지점의 ai_facts를 프롬프트에 함께 주입.
-- 공통 정보는 그대로 prompt_examples(category='facts')에서 관리.

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS ai_facts TEXT;
