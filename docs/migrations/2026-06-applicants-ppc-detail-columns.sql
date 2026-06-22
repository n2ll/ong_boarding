-- PPC별 상세 페이지에서 매니저가 한눈에 보고 편집할 컬럼들.
-- ----------------------------------------------------------------
-- 시트(동대문제기) 항목 중 DB에 없던 것:
--   baemin_id            : 배민 커넥트 아이디 (영문/숫자). 온보딩 단계 AI가 메시지에서 추출해 저장.
--   guide_sent           : 가이드 전달 여부 (boolean). 매니저 체크.
--   onboarding_call_status : 온보딩 통화 여부 / 대체수단 (text). "통화 완료" / "카톡대체" / 빈값 등 자유 입력.
--
-- 채널추가 여부는 기존 kakao_channel_friend(boolean) 재사용.

ALTER TABLE applicants
  ADD COLUMN IF NOT EXISTS baemin_id              TEXT,
  ADD COLUMN IF NOT EXISTS guide_sent             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS onboarding_call_status TEXT;

-- 인덱스: PPC 상세 페이지에서 (확정 지점 + 상태)로 자주 필터하므로
CREATE INDEX IF NOT EXISTS idx_applicants_confirmed_branch_status
  ON applicants (confirmed_branch, status)
  WHERE status IN ('확정인력', '대기자');
