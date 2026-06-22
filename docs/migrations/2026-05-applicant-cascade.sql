-- applicants 행 삭제 시 종속 테이블(messages, job_candidates, message_drafts)도
-- 자동으로 함께 삭제되도록 외래 키 정책을 ON DELETE CASCADE로 변경.
--
-- 배경: Supabase에서 applicants row 삭제 시
-- 'violates foreign key constraint ... referenced from table messages' 에러.
-- 매니저가 잘못 등록한 후보를 한 번에 지울 수 있게 한다.
--
-- 주의: CASCADE는 되돌릴 수 없는 삭제다. 매니저가 실수로 applicant를 지우면
-- 그 후보의 모든 대화·draft·job_candidates row가 함께 사라진다.
-- 운영상 안전이 중요하다면 대신 deleted_at 컬럼을 두고 soft-delete 패턴을 권장.

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_applicant_id_fkey;
ALTER TABLE messages
  ADD CONSTRAINT messages_applicant_id_fkey
  FOREIGN KEY (applicant_id) REFERENCES applicants(id)
  ON DELETE CASCADE;

ALTER TABLE job_candidates
  DROP CONSTRAINT IF EXISTS job_candidates_applicant_id_fkey;
ALTER TABLE job_candidates
  ADD CONSTRAINT job_candidates_applicant_id_fkey
  FOREIGN KEY (applicant_id) REFERENCES applicants(id)
  ON DELETE CASCADE;

ALTER TABLE message_drafts
  DROP CONSTRAINT IF EXISTS message_drafts_applicant_id_fkey;
ALTER TABLE message_drafts
  ADD CONSTRAINT message_drafts_applicant_id_fkey
  FOREIGN KEY (applicant_id) REFERENCES applicants(id)
  ON DELETE CASCADE;
