# multi-job conversation focus spec
flow:
  - 개인 공고함 조회 -> 현재 SMS 공고 id와 제목 반환 -> 해당 카드에 현재 대화 표시
  - A 대화 중 B 관심 확인 -> 관심만 저장 또는 관심 저장 후 B로 문자 대화 전환 선택
  - 관심만 저장 -> 기존 관심 원장 기록 -> A 초점 유지 -> B 자동 SMS 생략 사실을 화면에 표시
  - B 전환 -> 멱등 RPC로 B 관심·대화 공고·후속 의도를 한 트랜잭션으로 저장 -> auto면 B 첫 안내, 야간이면 큐, draft/off면 발송 없음
  - B 전환 후 일반 답장 -> conversation_focus_job_id가 가리키는 활성 B 후보로 라우팅
boundaries:
  - 관리자가 확정한 applicants.status='확정인력'의 current_job_id는 변경하지 않는다.
  - 전환 대상은 본인에게 노출된 모집 중 실공고여야 한다. 후보가 없으면 관심과 함께 생성한다.
  - 진행 중인 후보로 전환할 때는 상태를 유지하며 첫 안내를 다시 보내지 않는다.
  - unresolved pool engage outbox 또는 실행 중 agent reply claim이 있으면 전환하지 않는다.
  - 다른 공고를 언급한 자유문장은 현재 초점과 충돌하면 기존 ambiguous 경로로 보낸다.
  - 확정은 매니저만 수행한다.
  - 전환 이전 수신 문자를 새 공고 답변으로 재해석하지 않는다(조회와 발송 잠금에서 수신 시각 확인).
data:
  - public.select_pool_conversation_focus(job_id, applicant_id, action_key, engage_intent) security-definer RPC 추가
  - pool_events interest_click에 conversation_focus/interest_only 모드와 이전 공고 기록
  - applicants에 conversation_focus_job_id/conversation_focus_at/conversation_focus_action_key와 agent_reply_claim_key/agent_reply_claimed_at 추가
  - messages.agent_reply_deferred_at은 앞선 응답 때문에 잠금 대기한 문자의 복구 표시다. 실행 소유자가 자신의 문자만 완료 처리한다.
  - reply claim은 전환과 자동 응답·공고 되묻기의 동시 실행을 차단한다. 답장 지연과 연속 문자 병합은 잠금 전에 수행한다.
  - engage claim·야간 예약·예약 삭제는 applicant 잠금에서 선택 action 세대를 확인한다. 같은 B 공고로 돌아와도 예전 B 요청은 새 발송·예약을 만들지 못한다.
failure:
  - 토큰·공고·후보 불일치 -> 4xx, 상태 변경 없음
  - 확정·제외·수신거부 -> 409, 상태 변경 없음
  - 미해결 발송 원장 또는 reply claim -> 409, 상태 변경 없음
  - RPC 성공 후 자동 발송 실패 -> 관심과 B 초점은 유지하고 재시도 가능한 결과만 재개; 잘못된 자동 재발송 금지
  - 야간 -> SMS를 보내지 않고 기존 engage 큐 사용
  - focus 후보 null/paused/종료/조회 실패 -> 다른 공고 자동 응대와 캠페인 편입을 중지
  - 처리 중 비정상 종료·공급자 결과 unknown·발송 원장 저장 실패 -> reply claim 유지, 운영자가 공급자/로그 확인 후 해당 claim만 해제
  - 잠금 대기 중 도착한 문자는 sweeper가 복구하되, 관리자 답장·해당 문자 초안·현재 모드·공고 초점·보류 상태는 계속 확인한다.
  - 과거 전환 요청 재조회는 최신 초점과 superseded 결과를 반환해 취소된 야간 발송을 약속하지 않는다.
verification:
  - current focus가 여러 활성 후보 중 일반 답장의 라우팅 우선순위가 되는 단위 테스트
  - RPC의 멱등성·확정 보호·미해결 outbox 차단 통합 또는 계약 테스트
  - 개인 공고함의 관심만 저장/전환 응답과 접근성 테스트
  - 모바일 브라우저에서 A 진행 중 B 관심 두 경로 확인
  - npm run build
rollback: 먼저 AI 전역 off 후 앱을 이전 버전으로 돌린다. 추가 컬럼/함수/감사 이력은 유지해 데이터 손실을 피한다. 정상 복구 전 claim을 일괄 해제하지 않는다.
operations:
  - agent_reply_claim_key가 남은 지원자는 다른 공고로 자동 전환/응답하지 않는다.
  - 운영자는 applicants의 claim_key/claimed_at, messages, Vercel 실행 로그와 SMS 공급자 수신 결과를 대조한다.
  - 이전 실행이 끝났고 발송 상태가 확인된 경우에만 release_pool_agent_reply(applicant_id, 관찰한_claim_key)를 service_role로 호출한다.
  - 시간만으로 claim을 탈취하지 않는다. 관리자 수동 응대는 기존대로 가능하다.
