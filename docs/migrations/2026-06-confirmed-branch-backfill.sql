-- 확정인력/대기자 인데 confirmed_branch가 비어 있는 행 백필.
-- ----------------------------------------------------------------
-- 매니저가 status만 변경하고 confirmed_branch는 안 채워서 PPC 매트릭스/상세에 안 보이는
-- 기존 데이터를 1회용으로 정정. 앞으로의 PATCH는 라우트에서 자동 처리.
--
-- 정책: confirmed_branch가 NULL일 때 branch1(지원 시 1지망)을 그대로 사용.

UPDATE applicants
SET confirmed_branch = branch1
WHERE status IN ('확정인력', '대기자')
  AND confirmed_branch IS NULL
  AND branch1 IS NOT NULL;
