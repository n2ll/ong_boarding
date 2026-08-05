-- 2026-08 · jobs.slot 자유 텍스트 허용 (chk_jobs_slot 완화)
--
-- 왜: `jobs.slot`은 원래 배민 비마트 슬롯 보드의 4-슬롯 값('평일오전'…)이었다. 그 뒤 일반 배송
-- 라인(internal)이 들어오면서 근무시간을 자유 텍스트로 쓰기로 바뀌었고,
--   · 공고 수정 모달: internal이면 자유 텍스트 input (components/Jobs.tsx)
--   · 공고 등록 모달: 항상 자유 텍스트 input (placeholder "예: 월~토 오전 7시~")
--   · 지원자 카드(/p/[token])·에이전트 프롬프트(cross-job 블록): 자유 텍스트로 그대로 표시
--   · fit 판정(lib/pool-fit.jobSlotTokens): 자유 텍스트에서 명시 토큰만 추출
-- 이렇게 코드·화면·문서가 모두 자유 텍스트를 전제하는데 **DB 제약만 4-슬롯에 남아 있었다.**
--
-- 그래서 근무시간에 '평일 오전'(공백 포함)이나 '월~토 오전 7시~'를 넣으면 등록·수정이
-- 23514(check violation)로 실패하고, 화면에는 "공고 등록에 실패했어요"만 떴다.
-- 발사 예정 공고는 전부 internal(우리 인력에게) → 근무시간을 채우는 순간 저장 불가.
-- 실측(적용 전 프로덕션): slot 값은 '평일오전' 2건 + NULL 6건 — 자유 텍스트가 저장된 적이 한 번도 없다.
--
-- 되돌리기: 아래 DROP/ADD를 반대로 실행하면 원래 제약으로 복귀한다(기존 행은 모두 새 제약도 만족).
-- 배민 슬롯 보드는 `applicants.confirmed_slot`(별도 제약 유지)과 자체 집계를 쓰므로 영향 없다.

alter table jobs drop constraint if exists chk_jobs_slot;

-- 자유 텍스트 허용 — 길이만 제한한다(공고 카드·문자에 그대로 나가는 값이라 80자).
alter table jobs
  add constraint chk_jobs_slot
  check (slot is null or char_length(slot) <= 80);
