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

## 2026-09-06 운영 DB 적용
- 대상: 옹보딩 Supabase `lrktxyfzxwwpjffzltnq`. MCP는 읽기 전용이라 로그인된 해당 프로젝트 SQL Editor를 사용했다.
- 적용 전 선행 interest RPC·outbox·intent 원장 존재, 진행 중 발송 0건·pending intent 0건. 신규 컬럼은 없었다.
- AI auto → off를 비교 후 갱신하고 읽기로 확인했다(`2026-09-06T04:36:47.407Z`). 캐시 TTL과 webhook 최대 실행 시간 90초가 지난 후 적용했다.
- `2026-09-pool-conversation-focus.sql`을 단일 트랜잭션으로 적용했다. lock timeout 5초, statement timeout 45초, AI off·진행 중 발송 없음 guard, commit 후 PostgREST schema reload.
- 첫 시도는 SQL 편집기의 부분 텍스트 교체로 이전 조회문이 남아 구문 분석에서 실패했다. DB 컬럼 미생성 확인 → 전체 문서 선택/삭제 → 읽기 전용 교체 검증 → 원문 재입력 후 `PR129 migration committed` 확인. 앱/SQL 로직은 변경하지 않았다.
- 적용 후 신규 컬럼 6개 REST 조회 200. RPC 7개의 서명·고정 search_path·security definer 확인. 모두 service_role 실행 허용, anon/authenticated 실행 차단. 함수 본문은 주석·공백 정규화 후 저장소 정의와 MD5 7/7 일치했다.
- 원본 SQL SHA256: `b603d7d2ced507a8dd9039f566bd5248bc44fdf17738ec971c73fc50a3d9604e`.
- 앱 코드는 이전 검증 커밋 `e48a363`과 동일하다. 후속 변경은 운영 계획·근거 문서뿐이며 `git diff --check`를 다시 확인했다.
- 실제 SMS/Slack은 보내지 않았다. 통제된 수신번호 검수 전 AI off를 유지한다. DB 검증만으로 실제 모델 응대·폰 수발신 성공을 주장하지 않는다.

## 실제 모델 검수와 후속 보완
- PR129는 `c09abfc`로 squash merge, 해당 커밋의 Vercel 배포 success를 확인했다. AI off 상태에서 실제 Sonnet 4.6을 가상 공고·지원자에만 호출했다. SMS/Slack 경로는 차단하고 사용량은 `ai_usage_daily`의 improve로 기록했다.
- 수정 전 4건 중 첫 실행 1건 통과. 시간 질문을 interest 원문으로 제출해 서버가 차단했고, 관심·가용성 진술에는 묻지 않은 missing 항목 안내와 불필요한 인계가 나왔다. 같은 입력 재실행에서도 시간 질문의 interest 출력과 관심 진술의 missing 나열을 재현했다.
- 근본 원인: 단일 공고 스크리닝 규칙이 상담 원문 기록에 섞이고, answers/observations의 빈 배열 및 missing 목록의 의미가 충분히 구체적이지 않았다. 상담 지시·도구 항목 설명을 보완했다. 잘못된 출력 차단·확정 금지 규칙은 변경하지 않았다.
- 수정 후 같은 4건 **4/4 통과**: 시간 비교, 공고별 가능 요일, 모호한 긍정, 둘 다 관심. 호출은 시나리오당 1회, 프로필/입력 상태 변경 없음. 입력·출력·검증 항목은 `live-eval.json`에 보존했다.
- 결정론적 상담 helper·4개 stage 런타임 회귀 **69/69 통과** (`/tmp/ongboarding-consultation-prompt-tests.log`).
- `npm run build` exit 0 (타입·훅 검사 포함), 변경 파일 eslint exit 0, `git diff --check` clean. 빌드 로그: `/tmp/ongboarding-consultation-prompt-build.log`.
- 한계: 고정된 4개 가상 입력에 대한 관찰이며 자연어 전반의 품질 보장은 아니다. 두뇌 예시는 빈 fixture이고 운영 인입·저장·SMS 수발신은 아직 통제된 번호로 확인해야 한다.

## 2026-09-06 실제 SMS 왕복 검수
- PR130은 `a8c5589`로 머지됐고 Vercel Production Ready 및 운영 관리자 화면 정상 로드를 확인했다.
- 사용자가 제공한 기존 테스트 계정에 관리자 UI로 1건 발송했다. 13:59 KST 발송 요청은 outbox `recorded`, messages `sent`; 공급자 조회는 같은 요청 키의 `COMPLETE` / `4000`을 반환했다. 재발송하지 않았다.
- 사용자가 회신한 `옹보딩 수신 테스트`는 14:01:22 KST 인입으로 1건 저장됐고 테스트 계정에 연결됐다. `webhook_processed_at`은 14:01:24.870 KST이며 메시지의 공고 귀속은 null이다.
- 운영 관리자 대화 화면에서 실제 답장 표시·테스트 계정·AI 전역 중지 표시·로드 오류 없음을 확인했다.
- AI off 상태이며 실제 AI 상담 응답 검수는 별도다. 수동 발송은 해당 테스트 대화를 수동 개입 상태로 전환했다. 전체 AI를 재개하거나 다른 수신자에게 문자를 보내지 않았다.
- 14:13 KST 조회에서 기기 마지막 보고는 14:01:22.689 KST, pending_count=2였다. 이는 마지막 보고 값이며 현재 적체나 두 메시지의 실패를 확정하지 않는다. 이번 왕복 성공과 별도로 대기열 해소·주기적 heartbeat 안정성은 미확인이다.

## 운영 지침을 포함한 추가 검수
- 앞선 4건의 빈 prompt fixture 한계를 보완해 실제 `examples.ts`의 운영 지침·FAQ 로더와 Sonnet 4.6으로 가상 공고·지원자 6개 시나리오를 검수했다. 업무 데이터 쓰기·SMS·Slack 경로를 차단했고 모델 사용량만 improve로 기록했다.
- 연속 수신 첫 관심 발언 누락을 2회 재현했다. 미응답 원문이 history에도 있다는 이유로 과거 발언으로 제외됐다. `source_messages` 전체를 이번 처리 대상으로 명시한 후 두 원문/공고/종류가 모두 보존됐다.
- 공고가 하나로 줄어도 여러 공고 중 고르라는 문구, 비용 질문을 차량 보유 항목으로 바꾸는 문제를 수정했다. 인계 모드는 `consultation.mode`에 명시하도록 보완했다.
- FAQ 답변을 실제로 발송하지 않았는데 관리자 reason에 안내 완료로 적는 문제가 지시 보완 후에도 반복됐다. 인계 메모·reasoning·상태 메모는 서버가 공고명과 실제 수신 원문으로 구성한다. 악성 모델 요약으로 발송 완료를 주장할 수 없는 회귀 테스트를 추가했다.
- 최종 결과 모음은 **6/6 통과**: 시간·급여 비교, 연속 문자, 모호한 긍정, 공고 1개로 감소, 미지원 비용 질문 인계, 첫 공고 부정/둘째 공고 관심. 5건은 6개 전체 재실행에서, 비용 인계는 마지막 수정 후 해당 사례 재실행에서 확인했다. `operational-eval.json`에 입력 설정·결과·검증 항목 보존.
- 의미 있는 실패를 확인한 뒤 수정했다: 단일 공고 문구 2건 실패→통과, 잘못된 인계 요약 1건 실패→통과. 최종 helper/stage 테스트 **72 passed**, eslint·diff check 통과. 최종 `npm run build` exit 0, 타입·훅 검사 포함 (`/tmp/ongboarding-consultation-unanswered-build.log`).
- 17:54:42 KST 실제 모델의 비교 답변에 가상 공고 검수 안내를 붙여 사용자 테스트 계정에 관리자 UI로 1건 발송했다. outbox recorded/messages sent, 공급자 동일 요청 키 COMPLETE/4000 확인. 실제 연속 답장 2건은 대기 중이다. 이는 수동 검토·발송이며 자동 webhook→AI→SMS 완주를 검증한 것은 아니다.
- 17:55 KST 조회: 최신 기기 보고 17:52:10 KST, 대기 1건·배터리 100%. 기기 보고는 갱신되고 있으나 대기 메시지 내용/오류는 서버에서 조회할 수 없다. 앱 화면 확인을 요청했으며 삭제·재발송하지 않았다. 전체 AI off 유지.
