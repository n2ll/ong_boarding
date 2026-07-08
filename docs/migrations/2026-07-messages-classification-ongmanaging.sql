-- 인박스 '옹매니징 이관' 분류값 추가 (Phase C 파일럿, 2026-07-08)
-- ----------------------------------------------------------------
-- 배경: 미분류 인박스(매칭 안 된 번호의 문자)에 옹보딩 스코프 밖 문의
--   (재직자 앱 재등록 요청 등)가 섞여 온다. 기존 분류는 baemin/pending/other뿐이라
--   '기타'로만 처리돼 이관 기록·추적이 남지 않았다. 'ongmanaging' 값을 추가해
--   재직자·기존 계약자 문의를 명시적으로 이관 마킹한다(사유는 raw_payload.ongmanaging_transfer).
--
-- 순수 추가: 기존 행 위반 없음, 데이터 손실 없음. CHECK는 NULL을 통과시키므로
--   미처리 인입(classification IS NULL)에 영향 없음.
-- 재실행 시 주의: DROP은 IF EXISTS가 아니므로 제약이 이미 이 정의면 재실행 불필요.

ALTER TABLE public.messages DROP CONSTRAINT messages_classification_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_classification_check
  CHECK (classification = ANY (ARRAY['baemin'::text, 'pending'::text, 'other'::text, 'ongmanaging'::text]));
