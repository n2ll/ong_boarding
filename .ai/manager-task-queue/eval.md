# 검증
- `node --experimental-strip-types --test lib/message-preview.test.ts lib/admin/reply-completion.test.ts lib/admin/reply-completion-api.test.ts lib/admin/dashboard-priority.test.ts lib/admin/message-preview-request.test.ts`: 48/48 통과.
- RED→GREEN: paused 수신 대기일 집계 및 정확한 문자 완료 API/상태 회귀.
- 가상 브라우저: 실제 ReplyQueueCard와 LiveConsole, 모든 API·realtime 가상화. 초기 일반 답장 2건/인계 1건/완료 제외 확인.
- 수신 101 통화 완료+메모 → 답장 1건. 새 수신 105 → 2건. 저장 중 106 수신 → 409, 새 수신 보존.
- 모달 열린 채 갱신: 선택 사유·메모 유지. Live에서 완료 → Live/홈 모두 1건, 인계 유지. 대화 이력에 완료 메모 표시.
- 390px 모바일: 완료 모달/카드 버튼 확인, 가로 넘침 없음. 임시 QA 경로 삭제.
- 독립 리뷰: 폴링 시 모달 초기화 P2 발견, Dialog를 목록 밖에 유지하여 수정 후 재검토 통과. 서버 변경 추가 P1/P2 없음.
- 검수 중 운영 DB 수정·문자 발송·AI 호출 없음. 실제 후보 일정/상태는 변경하지 않음.
- `npm run build` 통과(Next.js 15.5.21, 타입·린트 포함). 기존 테스트 파일의 module 변수 린트 경고 3개만 유지. dev 중지·임시 페이지 제거 후 실행.
