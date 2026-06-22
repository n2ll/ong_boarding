-- 톤 가이드 / 퓨샷 예시 저장소
-- 매니저가 admin UI에서 추가/수정/삭제. AI 프롬프트도 이 테이블에서 동적 로드.
--
-- 적용:
--   1) 이 SQL을 Supabase SQL 에디터에서 실행
--   2) admin > "톤 가이드" 탭에서 "기본 예시 가져오기" 클릭 (1회) — 기존 txt 내용을 시드
--   3) 이후엔 DB가 source of truth. prompts/*.txt는 더 이상 읽히지 않음

CREATE TABLE IF NOT EXISTS prompt_examples (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('conversation', 'screening')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_examples_cat_order
  ON prompt_examples(category, sort_order);
