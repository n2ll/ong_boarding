-- 2026-07-applicants-available-slots.sql
-- M2 · 희망 시간대 축 — 지원자가 **최근에 직접 알려준** 가능 시간대를 담는 신설 컬럼.
--
-- 왜 새 컬럼인가:
--  · work_hours = 지원 당시 폼 답(기록). 덮어쓰면 "무엇이 언제 바뀌었나"를 되짚을 수 없다.
--    실데이터 645명 중 206명은 값이 '~' 한 글자(폼 잔여물)로, 어떤 파서로도 채울 수 없다.
--  · confirmed_slot = **비마트 슬롯 체계 전용**(매니저가 확정한 슬롯, 30명). 일반 라인의
--    '언제 가능한가'와 의미가 달라 재사용하지 않는다(사장님 확인, 2026-07-29).
--
-- 판정 순서는 lib/admin/types.ts applicantAvailableSlots(): available_slots → work_hours(토큰·파서).
-- 값은 4슬롯 정규 키만 허용 — AI가 자유 문자열을 넣어 아무 규칙에도 안 걸리는 상태를 막는다.

ALTER TABLE applicants
  ADD COLUMN IF NOT EXISTS available_slots text[],
  ADD COLUMN IF NOT EXISTS available_slots_updated_at timestamptz;

-- 정규 키 외 값 차단. 빈 배열도 제약은 통과하지만 **판정에서는 '신고 없음'과 같게 동작한다**
-- (applicantAvailableSlots는 self.length > 0일 때만 자기 신고를 채택한다). '4슬롯 다 안 됨'을
-- 별도로 기록할 필요가 생기면 그때 판정 규칙과 함께 정의한다 — 지금 그 값을 쓰는 곳은 없다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'applicants_available_slots_valid'
  ) THEN
    ALTER TABLE applicants
      ADD CONSTRAINT applicants_available_slots_valid
      CHECK (
        available_slots IS NULL
        OR available_slots <@ ARRAY['평일오전','평일오후','주말오전','주말오후']::text[]
      );
  END IF;
END $$;

COMMENT ON COLUMN applicants.available_slots IS
  '지원자가 최근에 알려준 가능 시간대(4슬롯 정규 키). work_hours(지원 당시 폼 답)보다 우선한다. NULL=자기 신고 없음.';
COMMENT ON COLUMN applicants.available_slots_updated_at IS
  'available_slots를 마지막으로 채운 시각 — 오래된 자기 신고를 구분하기 위해.';
