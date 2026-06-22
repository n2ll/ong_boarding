-- 시스템 발송 문구 5종을 prompt_examples에 직접 시드.
-- 클로드 조련하기 > 시스템 발송 문구 탭에서 편집할 수 있도록 기본값을 DB에 넣는다.
-- 멱등: 이미 같은 (category, title)이 있으면 건너뜀.
--
-- 본문에 {{이름}}을 쓰면 발송 시 지원자 이름으로 치환됨.
-- 제목(title)은 시스템이 찾는 고정 키 — 바꾸지 말 것.

-- 1) 당근 시작 멘트 (스크리닝 진입 인사 + 안내 묶음 — {{지점}}/{{시간대}}/{{이름}} 치환)
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'system_message', 'danggeun_start', $body$안녕하세요 {{지점}} {{시간대}} 지원해 주신 {{이름}}님, 지원해 주셔서 감사합니다!
진행 전 몇 가지 안내드릴게요.

1) 업무시간은 배차 시간 기준입니다.
   08:00 첫 배차 / 16:00 마지막 배차이고, 배송 시간은 별도로 산정됩니다.
2) 정산은 건당 금액이 매주, 프로모션 비용은 2주 간격으로 진행됩니다.
3) 프로모션 5천원 비용은 1~2개월 후 종료될 수 있는 점 참고 부탁드려요.

읽어보시고 괜찮으시면 몇 가지만 짧게 여쭤볼게요^^$body$, 10
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='system_message' AND title='danggeun_start');

-- (이미 danggeun_start가 있는 경우 본문을 새 버전으로 덮어쓰려면 아래 UPDATE 실행)
-- UPDATE prompt_examples SET body = $body$안녕하세요 {{지점}} {{시간대}} 지원해 주신 {{이름}}님, 지원해 주셔서 감사합니다!
-- 진행 전 몇 가지 안내드릴게요.
--
-- 1) 업무시간은 배차 시간 기준입니다.
--    08:00 첫 배차 / 16:00 마지막 배차이고, 배송 시간은 별도로 산정됩니다.
-- 2) 정산은 건당 금액이 매주, 프로모션 비용은 2주 간격으로 진행됩니다.
-- 3) 프로모션 5천원 비용은 1~2개월 후 종료될 수 있는 점 참고 부탁드려요.
--
-- 읽어보시고 괜찮으시면 몇 가지만 짧게 여쭤볼게요^^$body$
-- WHERE category='system_message' AND title='danggeun_start';

-- 2) apply 폼 접수 안내
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'system_message', 'apply_received', $body$[옹고잉 배송원 지원 접수 안내]

{{이름}}님, 안녕하세요.
옹고잉 배송원 지원서가 정상 접수되었습니다.

서류 검토 후 영업일 기준 1~2일 내 유선으로 연락드릴 예정입니다.
문의사항은 본 메시지에 회신 주시면 빠르게 안내드리겠습니다.$body$, 20
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='system_message' AND title='apply_received');

-- 3) 스크리닝 진입 안내 묶음
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'system_message', 'screening_announce', $body${{이름}}님, 본격적인 진행을 위해 몇 가지 안내드릴게요!

1) 업무시간은 배차 시간 기준입니다.
   08:00 첫 배차 / 16:00 마지막 배차이고, 배송 시간은 별도로 산정됩니다.
2) 정산은 건당 금액이 매주, 프로모션 비용은 2주 간격으로 진행됩니다.
3) 프로모션 5천원 비용은 1~2개월 후 종료될 수 있는 점 참고 부탁드려요.

읽어보시고 괜찮으시면 몇 가지만 짧게 여쭤볼게요^^$body$, 30
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='system_message' AND title='screening_announce');

-- 4) 온보딩 진입 앱설치/교육 안내
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'system_message', 'onboarding_guide', $body$업무 진행을 위한 앱설치 및 요청사항을 전달드립니다. 영상교육 수료 후, 회신 부탁드립니다.

1. 배민 커넥트 앱 설치 후 가입
2. 앱 가입 시 안전보건교육 영상(2시간) 필수 시청 필요
3. 가입 및 교육 수료 후 마이페이지 > 내 정보에서 '아이디' 확인 후, 아이디 회신 부탁드립니다.
4. 차량번호도 함께 회신 부탁드립니다.

[참고 자료]
가입 가이드: https://www.youtube.com/watch?v=bMM112zT7JY
사용법 가이드: https://www.youtube.com/watch?v=5547PR3fzRs$body$, 40
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='system_message' AND title='onboarding_guide');

-- 5) 첫 출근 룰 안내
INSERT INTO prompt_examples (category, title, body, sort_order)
SELECT 'system_message', 'first_day_rules', $body${{이름}}님 안녕하세요? 첫 근무 관련 안내사항 전달드립니다!

1) 08시 경에 나오셔서 카카오 채널로 건물 또는 주차하신 사진 부탁드립니다 (현재 활동 여부 확인용).
2) 배차 들어오면 수락해 주시고(라우트는 자동), 가까운 곳 우선으로 돌아주시면 감사하겠습니다.
3) 식사는 13시 이후로 진행 부탁드립니다.
4) 배차 시점부터 60분 내 배송 완료 부탁드립니다.
5) 상차지에서 배차 받고 10분 대기 후 출발 부탁드립니다.$body$, 50
WHERE NOT EXISTS (SELECT 1 FROM prompt_examples WHERE category='system_message' AND title='first_day_rules');

-- 확인용
-- SELECT category, title, sort_order FROM prompt_examples WHERE category='system_message' ORDER BY sort_order;
