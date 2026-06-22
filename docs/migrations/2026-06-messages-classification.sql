-- 미매칭 phone 인입 메시지 분류 컬럼.
-- ----------------------------------------------------------------
-- 값:
--   'baemin'  : AI 또는 매니저가 배민 지원으로 확정 → applicants 생성됨
--   'pending' : AI가 자신없음 → 매니저 미분류 인박스에 노출
--   'other'   : 명백한 스팸/지인/기타 → 무시
--   NULL      : 분류 대상 아님 (기존 applicant 매칭됐거나 등록 전 데이터)

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS classification TEXT
    CHECK (classification IN ('baemin', 'pending', 'other'));

-- 미분류 인박스 쿼리가 자주 도는 인덱스
CREATE INDEX IF NOT EXISTS idx_messages_pending
  ON messages (created_at DESC)
  WHERE classification = 'pending';
