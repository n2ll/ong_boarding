# multi-job consultation evaluation

date: 2026-09-06
scope: 진행 중 SMS의 복수 공고 조건 안내 / 공고별 원문 기록 / 모호한 답변 보호

## 실행 근거
- `node --experimental-strip-types --test lib/agent/*.test.ts lib/agent/stages/consultation.test.ts lib/pool-conversation-focus-api.test.ts lib/pool-conversation-focus.test.ts lib/pool-action.test.ts lib/sms-consent-policy.test.ts lib/pool-engage-claim.test.ts lib/pool-durable-action.test.ts`: **259 passed / 0 failed / 0 skipped** (`/tmp/multi-job-consultation-tests.log`).
  - 노출 정책·연속 SMS·멱등 이벤트·실제 stage 파서·router 부수효과와 기존 reply claim/발송 보호를 검증했다. Claude 응답·DB·발송은 fixture이며 실제 외부 호출은 없다.
  - 상담 helper 47건 + stage 런타임 22건은 한 번의 모델 호출, usage 보존, 악성/잘못된 출력의 체크리스트·프로필 변경 차단을 포함한다.
- `npm run build`: **exit 0**, 타입/훅 검사 포함 (`/tmp/multi-job-consultation-build.log`). 이후 앱 변경은 주석뿐이다. `npx tsc --noEmit`도 exit 0.
- 기존 공고 전환 E2E: 배포용 빌드(`next start`)에서 **18 passed**, 390px/1280px (`/tmp/multi-job-consultation-e2e.log`). 함께 시도한 관리자 화면 2건은 인증 env 없는 production의 정상 503으로 실패해 전용 로컬 인증 fixture로 분리했다.
- 관리자 타임라인 E2E: **2 passed / 0 failed**, 390px/1280px (`/tmp/multi-job-consultation-ui.log`). 재현 명령은 `npx playwright test --config=playwright.consultation.config.ts`.
  - 실제 미들웨어 + 로컬 Supabase 인증 fixture + 관리자 API fixture, Realtime/외부 요청 격리. 운영 인증 코드 변경 없음. 초기 빈 env의 Realtime 오류와 중복 이름 선택자를 검수 설정에서 해결했다.
  - 공고별 3개 원문, 같은 공고의 연속 발언 보존, 스크롤 후 화면 안의 줄바꿈·잘림 여부, pageerror/미예상 요청 0건을 검증했다. `/tmp/multi-job-consultation-{390,1280}.png` 직접 확인.
  - 기존 모바일 운영 화면은 상단 큐·헤더가 커서 상담 내용을 보려면 스크롤해야 한다. 이번 범위에서 전체 화면 구조는 바꾸지 않았다.
- 변경 핵심 파일·새 브라우저 설정 `npx eslint`: exit 0. `git diff --check`: clean.

## 재현 후 보완한 위험
- 모델이 다른 공고의 절, 부정 발언, 질문에서 잘라낸 긍정을 관심/가용성으로 기록하는 경우.
- 복수 상담 도중 한 공고가 비노출이 된 뒤 짧은 긍정을 남은 공고 동의로 단정하는 경우.
- 상담을 처리한 후보의 responded_at·지원자 상태·전역 가용성이 바뀌거나, 수신 문자가 그 공고로 잘못 귀속되는 경우.
- 상담 검증 실패가 코파일럿에서 아무 초안도 없이 사라지는 경우. need_info 초안을 남긴다.
- partial unique index인 action_key를 일반 upsert로 쓰는 문제. INSERT 충돌 시 기존 원문을 검증하고 누락 항목만 재시도한다.
- 기존 수신거부 검사의 코드 문자열 기준이 가용성 분류 조건 변경으로 깨진 경우. 수신거부가 실제 분류 호출보다 먼저 처리되는 기준으로 갱신했다.

## 한계와 운영 적용
- 실제 Claude의 자연어 해석 품질·운영 DB·SMS·Slack·법인폰 연결 상태는 이번 검증 대상이 아니다. 규칙 검증은 명백한 오귀속을 막는 보조 장치이며 자연어의 모든 모호함을 증명하지 않는다.
- 관심/가용성은 원문 관찰이다. 다른 공고에 후보를 자동 생성하거나 병렬로 체크리스트를 진행시키지 않는다. 근무 확정은 매니저가 한다.
- 코파일럿의 관찰 제안은 미저장이다. 매니저가 초안을 발송해도 자동으로 관찰 이벤트를 확정하지 않는다.
- 이번 추가 상담 기능 자체의 새 마이그레이션은 없다. PR129의 `2026-09-pool-conversation-focus.sql`은 여전히 앱보다 먼저 적용해야 한다.
- 적용 순서: AI off → 선행 DB migration → 앱 배포 → 통제된 폰으로 A/B 조건 질문·공고별 가능 시간·모호한 긍정·연속 SMS 확인 → 파일럿. 복구는 AI off 후 앱 롤백, 관찰 이력 보존.
