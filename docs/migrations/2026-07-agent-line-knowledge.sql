-- 일반 배송 라인(도시락 등 recruit_mode='internal' 실공고) AI 스크리닝 지식 시드
-- (2026-07 실무자 인터뷰 확정 지식 인코딩 — 비마트 지식과 분리)
--
-- 1) prompt_examples category에 'knowledge' 허용
--    - 일반 라인 FAQ 전용 카테고리. internal 실공고의 exploration/screening 프롬프트에만 주입된다.
--    - 'facts'(전 지점 공통, 모든 프롬프트에 주입)에 넣으면 비마트 응대가 오염되므로 분리.
--    - 어드민 "클로드 조련하기 > 사내 지식 베이스 > 일반 라인 FAQ" 탭에서 편집 가능.
-- 2) FAQ 6종 시드 (category='knowledge')
-- 3) 일반 라인 시스템 발송 문구 2종 시드 (category='system_message')
--
-- 멱등: prompt_examples에는 (category, title) 유니크 제약이 없어 ON CONFLICT를 쓸 수 없다
-- (유니크 인덱스 추가는 기존 중복 행 존재 시 실패 위험 + 타 카테고리 의미 변경이라 보류).
-- 기존 시드 파일(2026-05-seed-system-messages.sql)과 동일하게 WHERE NOT EXISTS로 멱등 처리.

-- ── 1) category CHECK 확장 ─────────────────────────────────────
ALTER TABLE prompt_examples
  DROP CONSTRAINT IF EXISTS prompt_examples_category_check;

ALTER TABLE prompt_examples
  ADD CONSTRAINT prompt_examples_category_check
  CHECK (category IN ('conversation', 'screening', 'facts', 'system_message', 'knowledge'));

-- ── 2) 일반 라인 FAQ (AI 공식 답변 — 이 범위 안에서만 직접 답변) ──

-- 정산 (조기 정산·선지급 약속 금지)
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'knowledge', '정산·지급일', $body$급여는 익월 5일에 지급돼요. 계약 형태(정규직/프리랜서/단기)에 따라 세금 공제가 달라져서, 자세한 내용은 매니저가 안내드려요.
(⚠️ AI 주의: 조기 정산·선지급은 절대 약속하지 말 것)$body$, 10
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='knowledge' AND title='정산·지급일');

-- 유류비
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'knowledge', '유류비', $body$유류비는 자차·법인 렌트 차량 모두 개인 부담이에요.$body$, 20
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='knowledge' AND title='유류비');

-- 과태료
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'knowledge', '과태료', $body$업무 중 발생한 일반적인 주차 과태료는 소명 절차 후에도 납부가 필요한 경우 회사(옹고잉)에서 부담해요. 그 외 신호위반·속도위반 등 과태료는 개인 부담이에요.$body$, 30
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='knowledge' AND title='과태료');

-- 선탑(동승)
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'knowledge', '선탑(동승)', $body$선탑은 실제 투입 전에 운행 중인 라인에 조수석으로 동승해서 현장과 업무를 익히는 과정이에요. 투입 후에도 필요하면 하루 정도 동승 교육을 추가할 수 있어요.$body$, 40
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='knowledge' AND title='선탑(동승)');

-- 보험
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'knowledge', '보험(유상운송·산재)', $body$유상운송보험은 필수가 아니에요. 프리랜서 계약의 경우 특수고용직 배송원 등록 시 산재보험이 적용돼요.$body$, 50
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='knowledge' AND title='보험(유상운송·산재)');

-- 법인차 렌트 (차종 미달·차량 없음은 부적합 사유 아님)
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'knowledge', '법인차 렌트', $body$차량이 없거나 공고 차종 요건에 맞지 않는 경우, 법인 차량 렌트를 이용할 수 있는 경우가 있어요. 사용료가 발생하고 유류비는 개인 부담이에요. 원하시면 매니저가 자세히 안내드려요.
(⚠️ AI 주의: 차종 미달·차량 없음은 부적합(abort) 사유가 아님 — 이 안내 후 계속 진행하고 '법인차 렌트 희망'을 기록할 것)$body$, 60
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='knowledge' AND title='법인차 렌트');

-- ── 3) 일반 라인 시스템 발송 문구 ({{이름}} 치환) ──────────────

-- 스크리닝 진입 첫 확인질문 묶음 (비마트 screening_announce 대체 — internal 공고 전용)
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'system_message', 'general_screening_announce', $body${{이름}}님, 관심 감사합니다! 빠른 진행을 위해 몇 가지만 여쭤볼게요.
- 지금 운행하시는 차량(차종)이 어떻게 되세요?
- 본인 명의로 정산 받으시는 데 문제는 없으실까요?
편하게 답장 주세요 😊$body$, 60
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='system_message' AND title='general_screening_announce');

-- 스크리닝 통과 시 선탑(동승) 인계 마무리 (비마트 onboarding_guide 대체 — 확정 뉘앙스 금지, 연락 예고까지만)
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'system_message', 'general_screening_handoff', $body${{이름}}님, 확인 감사합니다! 담당 매니저가 선탑(동승) 일정을 잡아 연락드릴게요 😊$body$, 61
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='system_message' AND title='general_screening_handoff');

-- 확인용
-- SELECT category, title, sort_order FROM prompt_examples WHERE category IN ('knowledge') OR title LIKE 'general_%' ORDER BY category, sort_order;
