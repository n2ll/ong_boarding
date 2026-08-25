-- 전역 AI 응답 모드 저장 행은 일반 프롬프트가 아니라 운영 제어 상태다.
-- 중복 행이 있으면 안전 우선(off > draft > auto)으로 하나만 보존하고,
-- 이후에는 부분 유니크 인덱스로 정확히 한 행만 생성될 수 있게 한다.

BEGIN;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      ORDER BY
        CASE BTRIM(body)
          WHEN 'draft' THEN 1
          WHEN '' THEN 2
          WHEN '0' THEN 2
          ELSE 0
        END,
        updated_at DESC NULLS LAST,
        id DESC
    ) AS row_number
  FROM prompt_examples
  WHERE category = 'system_message' AND title = 'agent_kill_switch'
)
DELETE FROM prompt_examples
WHERE id IN (SELECT id FROM ranked WHERE row_number > 1);

-- 알려진 auto 표현만 '0'으로 정규화하고, 손상·미확인 값은 안전상 off로 둔다.
UPDATE prompt_examples
SET body = CASE BTRIM(body)
  WHEN '' THEN '0'
  WHEN '0' THEN '0'
  WHEN 'draft' THEN 'draft'
  ELSE '1'
END
WHERE category = 'system_message' AND title = 'agent_kill_switch';

CREATE UNIQUE INDEX IF NOT EXISTS uq_prompt_examples_agent_kill_switch
  ON prompt_examples (category, title)
  WHERE category = 'system_message' AND title = 'agent_kill_switch';

COMMENT ON INDEX uq_prompt_examples_agent_kill_switch IS
  '전역 AI 응답 모드 예약 행의 중복 생성과 불명확한 런타임 상태를 방지한다.';

COMMIT;
