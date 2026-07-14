-- 확정 단계 편집 가능 템플릿 시드 (system_message).
-- 두뇌 탭에서 편집. 본문이 비어 있으면 코드 기본 문안(라인 형태별)으로 폴백한다.
--   ongoing_app_guide       : 확정 시 옹고잉 앱 설치·가이드 안내 (실제 링크·문구는 운영에서 입력)
--   first_day_rules_general : 도시락 등 internal 정기배송 라인 첫날 규칙 (배민 배차 모델 아님)
--   venue_guide             : 만남장소 안내 (구조화 발송은 서버 빌드가 우선 — 참고용 편집 슬롯)
-- {{이름}} placeholder는 발송 시 지원자 이름으로 치환된다.

insert into prompt_examples (category, title, body)
select 'system_message', 'ongoing_app_guide',
  E'{{이름}}님, 함께하게 되어 반갑습니다! 업무 진행을 위해 옹고잉 앱 설치를 안내드립니다.\n\n(옹고잉 앱 설치 링크·가이드 내용을 여기에 넣어주세요)'
where not exists (
  select 1 from prompt_examples where category = 'system_message' and title = 'ongoing_app_guide'
);

insert into prompt_examples (category, title, body)
select 'system_message', 'first_day_rules_general',
  E'{{이름}}님, 첫 근무 관련 안내드립니다!\n\n1) 안내드린 집합 시간·장소로 나와주세요. 도착하시면 현장 담당자에게 알려주세요.\n2) 선탑(동승) 때 익히신 순서·경로대로 상차 후 배송 진행 부탁드립니다.\n3) 배송 완료 후 회수품·잔여물은 정해진 반납 절차대로 처리해 주세요.\n4) 진행 중 문제가 생기면 바로 현장 담당자에게 연락 주세요.'
where not exists (
  select 1 from prompt_examples where category = 'system_message' and title = 'first_day_rules_general'
);
