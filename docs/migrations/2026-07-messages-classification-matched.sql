-- 인박스 '공고 등록' 분류값 추가 (실무자 UX 개편 B1, 2026-07-26)
-- ----------------------------------------------------------------
-- 배경(기존 버그): 문자함에서 '지원자로 등록'(action='job')하면 라우트가 인입 문자를
--   classification='matched' + applicant_id + job_id 로 업데이트해 대화·지원자를 링크한다
--   (app/api/admin/inbox/[id]/classify/route.ts). 그런데 CHECK 제약에 'matched'가 없어
--   이 업데이트가 23514로 **조용히 실패**해 왔다(supabase-js는 throw하지 않고, 코드도 error를
--   확인하지 않았음). 결과: 공고 등록 지원자의 인입 문자가 pending으로 남고 applicant_id도 안 붙어
--   ① 문자함 카드가 되살아나고 ② 실시간 응대 목록의 '초안 검토' 신호(미리보기가 messages.applicant_id
--   기준)가 뜨지 않았다. 등록 시 문자를 자동 발송하던 동안엔 표시 문제였지만, B1에서 등록을
--   '초안 생성 + 매니저 수동 발송'으로 바꾸면서 매니저가 초안을 못 찾는 무응답 방치로 이어진다.
--
-- 순수 추가: 기존 행 위반 없음(현재 'matched' 행 0건), 데이터 손실 없음.
--   CHECK는 NULL을 통과시키므로 미처리 인입(classification IS NULL)에 영향 없음.
--   조회 측은 모두 classification='pending'만 필터하므로(inbox/pending·notifications·automation)
--   값 추가로 기존 집계·목록이 바뀌지 않는다.
-- 재실행 시 주의: DROP은 IF EXISTS가 아니므로 제약이 이미 이 정의면 재실행 불필요.

ALTER TABLE public.messages DROP CONSTRAINT messages_classification_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_classification_check
  CHECK (classification = ANY (ARRAY['baemin'::text, 'pending'::text, 'other'::text, 'ongmanaging'::text, 'matched'::text]));
