# multi-job conversation focus evaluation

date: 2026-09-06
scope: 관심 다중 유지 / 명시적 SMS 공고 선택 / 동시 응답·재시도 보호

## 실행 근거
- `node --experimental-strip-types --test` 아래 13개 파일: **132 passed / 0 failed / 0 skipped** (`/tmp/multi-job-focus-tests.log`).
  - `lib/agent/{inbound-routing,conversation-reply-claim,router-phone-identity,inbound-sweeper-deferred,transitions-delivery,outbound-safety,general-line}.test.ts`
  - `lib/{pool-conversation-focus-api,pool-conversation-focus,pool-action,sms-consent-policy,pool-engage-claim,pool-durable-action}.test.ts`
- `lib/pool-conversation-focus.integration.test.ts`: **20 시나리오 + 상위 테스트 = 21 passed / 0 failed / 0 skipped**, 실제 폐기 PostgreSQL 14 (`/tmp/ong-focus-final-green.log`). 기존 interest/outbox SQL을 그대로 적용했고 사업 로직 RPC는 모킹하지 않았다.
  - 실행: `ONG_CONVERSATION_FOCUS_AUDIT_DATABASE_URL='postgresql://127.0.0.1:55439/ong_focus_final_green' node --experimental-strip-types --test lib/pool-conversation-focus.integration.test.ts`
  - `ongboarding.migration_audit = 'enabled'`로 표시한 전용 DB에서만 실행. 일반/운영 DB에서는 실행 금지. 검증 후 로컬 DB 서버 종료.
  - 동일 SQL 재적용: `psql -h 127.0.0.1 -p 55439 -d ong_focus_final_green -v ON_ERROR_STOP=1 -f docs/migrations/2026-09-pool-conversation-focus.sql` exit 0.
- `npm run build`: **exit 0**, 타입/훅 검사 포함 (`/tmp/multi-job-focus-build.log`). 앱 코드 변경 완료 후 실행.
- 배포용 브라우저 E2E: **18 passed / 0 failed** (8.7s, `/tmp/pool-focus-e2e-production.log`). `next start`의 고립된 3177 포트에서 390px/1280px 화면과 전환·재시도·제한 상태를 검증했다. 테스트 API fixture 사용, 외부 호출 차단.
  - 실행: `npx playwright test --config=/tmp/pool-focus-playwright.config.ts e2e/pool-conversation-focus.spec.ts`. 저장소 설정을 상속하고 서버만 `next start`, readiness `/p/focus-test`, `reuseExistingServer: false`로 지정했다. 검증 후 서버 종료.
  - 모바일 화면: `/tmp/pool-focus-mobile-choice.png`, `/tmp/pool-focus-mobile-result.png`. 이전 공고의 상태는 ‘진행 내용이 저장돼 있어요’로, 현재 공고의 문자 대화와 구분한다.

## 재현 후 보완한 위험
- 지연 중 잠금 → 최신 핸들러 busy → 이전 핸들러 coalesced로 둘 다 응답하지 못하는 경우.
- 앞선 AI 응답 중 도착한 문자를 이후 발송/last_run_at만으로 처리 완료로 간주하는 경우.
- 정상 반환된 provider unknown·발송 원장 저장 실패로 응답 잠금이 해제되는 경우.
- B→C→B 선택 이후 과거 B 요청이 새 발송·야간 예약을 만들거나 최신 예약을 삭제하는 경우.
- 과거 요청 재조회가 최신 선택에도 취소된 야간 안내를 약속하는 경우.
- 관심이 이미 있는 카드에서 전환 확인창이 숨겨지는 UI 조건.

## 운영 한계와 다음 단계
- 운영 DB 적용·프로덕션 배포·실제 SMS 및 관리자 알림 발송은 이번 검증에 포함하지 않았다.
- DB migration을 새 앱보다 먼저 적용해야 한다. rollback 전 AI off가 필요하다.
- 공급자 결과가 불명확하거나 실행이 중단되면 잠금이 자동 만료되지 않는다. 운영자가 로그/공급자 확인 후 소유 key를 지정해 해제한다.
- 전체 저장소 테스트나 법인폰 연결 상태를 검증했다는 의미는 아니다. 실제 폰으로 A 관심 → B 선택 → 문자 답장 귀속을 확인한 후 파일럿을 진행한다.
- 개발 모드 E2E의 간헐적 clientReferenceManifest/HMR 오류는 소스를 고정한 배포용 빌드에서 재현되지 않았다. 기능 코드를 우회하지 않았다.
