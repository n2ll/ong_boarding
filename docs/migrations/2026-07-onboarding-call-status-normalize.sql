-- onboarding_call_status 자유입력 쓰레기값 정규화 → '통화 완료'.
-- ----------------------------------------------------------------
-- 배경:
--   onboarding_call_status는 TEXT 자유입력으로 도입됐고
--   (2026-06-applicants-ppc-detail-columns.sql), select 옵션
--   (미실시/통화 완료/부재중/예정/카톡대체)은 사후 도입이라 옵션에 없는
--   기존 값들이 그대로 남아 있다.
--   실DB 분포: null 596, 'o' 20, '통화 완료' 11, '전화완료' 8,
--   'o 10:00' 2, '카톡대체' 1, '통화 중단 - 스케줄 까먹고 계셨음' 1, 'o 09:30' 1.
--   옵션에 없는 값은 상세 패널 select에서 빈 값으로 렌더돼 사라져 보였고,
--   Dashboard 집계는 includes('완료') 문자열 매칭이라 'o' 계열이 누락됐다.
--
-- 조치:
--   'o' / 'o %'(시각 병기) / '전화완료' / '통화 중단%' → '통화 완료'로 정규화.
--   '카톡대체'는 유효 옵션이므로 유지, null(미지정)은 그대로 둔다.
--   API PATCH enum 검증(app/api/admin/applicants/[id]/route.ts) +
--   UI 옵션 확정(ApplicantDetailPanel)과 세트로 적용 — 이후 재유입 없음.
--
-- ⚠️ 1회용 (UPDATE) — 다만 WHERE가 정규화 대상만 매칭하므로 재실행해도 0건 갱신, 재실행 안전.

-- dry-run: UPDATE 전에 영향 범위 먼저 확인
-- SELECT onboarding_call_status, COUNT(*)
-- FROM applicants
-- WHERE onboarding_call_status = 'o'
--    OR onboarding_call_status LIKE 'o %'
--    OR onboarding_call_status = '전화완료'
--    OR onboarding_call_status LIKE '통화 중단%'
-- GROUP BY onboarding_call_status;

UPDATE applicants
SET onboarding_call_status = '통화 완료'
WHERE onboarding_call_status = 'o'
   OR onboarding_call_status LIKE 'o %'
   OR onboarding_call_status = '전화완료'
   OR onboarding_call_status LIKE '통화 중단%';
