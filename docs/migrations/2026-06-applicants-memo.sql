-- 지원자별 매니저 메모 컬럼 추가
--
-- 배경: 기존 `note` 컬럼이 (1) "중복지원" 같은 시스템 태그와 (2) 매니저 자유 메모를
-- 동시에 담아 충돌이 났음(매니저가 메모를 쓰면 시스템 태그가 덮어쓰여 사라짐).
-- 둘을 분리:
--   - note  : 시스템이 자동으로 다는 태그 ("중복지원" 등). UI 읽기 전용.
--   - memo  : 매니저가 자유롭게 쓰고 편집하는 메모. UI 어디서나 편집 가능.

ALTER TABLE applicants
  ADD COLUMN IF NOT EXISTS memo TEXT;

-- 기존 note에 들어있던 비-시스템 텍스트는 memo로 옮긴다. 시스템 태그("중복지원")는 그대로 두고
-- 자유 텍스트만 이전. 두 가지가 한 행에 동시에 있던 경우는 거의 없으므로 단순 분기.
UPDATE applicants
   SET memo = note,
       note = NULL
 WHERE memo IS NULL
   AND note IS NOT NULL
   AND note <> '중복지원';
