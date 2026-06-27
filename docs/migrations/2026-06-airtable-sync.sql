-- Airtable(옹고잉 지원자 테이블) → applicants 주기 동기화용 컬럼.
-- ----------------------------------------------------------------
--   airtable_record_id : Airtable 레코드 id(rec...). 멱등성 키 — 같은 레코드 중복 INSERT 방지.
--   airtable_raw       : Tally 폼 49필드 전체 원본(jsonb). applicants 정식 컬럼에 자리 없는
--                        항목(이메일·체력/들기 능력·직업관·기대 등)을 무손실 보존.
--
-- 동기화는 INSERT-only(신규 레코드만). 기존 phone과 겹치면 건너뛰어 라이브 파이프라인 row를 보호한다.

ALTER TABLE applicants
  ADD COLUMN IF NOT EXISTS airtable_record_id TEXT,
  ADD COLUMN IF NOT EXISTS airtable_raw       JSONB;

-- airtable_record_id 멱등성: NULL(=Airtable 출신 아님)은 제외한 부분 유니크.
CREATE UNIQUE INDEX IF NOT EXISTS uq_applicants_airtable_record_id
  ON applicants (airtable_record_id)
  WHERE airtable_record_id IS NOT NULL;
