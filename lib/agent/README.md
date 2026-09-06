# `lib/agent/` — AI 응대 엔진

지원자 SMS에 자동 응답하는 Claude 기반 에이전트 시스템. 인입 1건 = 단계 모듈 1회 호출 = Claude API 1회 호출.

## 흐름 한눈에

```
인입 SMS → router.runAgentForCandidate
  ├─ job_candidates 로드 → 현재 stage 결정
  ├─ 지원자별 노출 공고·최근 SMS 확인 → 단일 진행 / 공고별 상담 검증
  ├─ stage.process() → Claude 호출 → reply_text + transition + checklist 갱신
  ├─ SOLAPI 발송 → messages INSERT (토큰 비용 포함)
  └─ transitions.applyTransition() → status 갱신 + 자동 발송(GUIDE 등) + Slack
```

## 파일별 책임

| 파일 | 역할 |
|---|---|
| `router.ts` | 진입점. stage 라우팅 + 응답 발송 + transition 처리. 1분 텀(coalesce) 로직 포함. |
| `multi-job-consultation.ts` | 기존 단계 호출에 상담 tool 계약을 추가. 공고 데이터로 답변을 구성하고 공고·원문·현재 단계 진행 여부를 검증. |
| `consultation-context.ts` / `consultation-history.ts` | 지원자별 상담 노출 정책과 최근 50개 SMS·연속 미응답 문자 조회. 조회 실패나 잘린 연속 문맥은 관리자 확인. |
| `consultation-observations.ts` | 공고·수신문자별 관심/가용성 발언을 `pool_events`에 멱등 기록. 체크리스트나 전역 가용성은 변경하지 않음. |
| `types.ts` | StageContext / StageResult / ScreeningChecklist / OnboardingChecklist 등 코어 타입. |
| `stages/` | 단계별 모듈 — exploration / screening / onboarding / active. 각각 Claude tool_use로 응답 |
| `transitions.ts` | 단계 전이의 부수효과 — 자동 발송(SCREENING_ANNOUNCE/GUIDE/마무리), status 갱신, Slack 알림 |
| `checklist.ts` | screening 7항목 + onboarding 1항목 키 정의 + isComplete / mergeAgentState 유틸 |
| `examples.ts` | DB의 `prompt_examples`(대화 톤·운영 정보·시스템 메시지)를 프롬프트로 빌드. 60초 캐시. |
| `system-messages.ts` | 자동 발송 멘트 키별 조회 — `danggeun_start` / `onboarding_guide` 등. `{{이름}}` placeholder 치환. |
| `prompt-examples-seed.ts` | "[기본값 채우기]" 버튼이 INSERT할 시드 예시 (대화 8건 + 시스템 메시지 7건). |
| `danggeun-job.ts` / `baemin-job.ts` | 시스템 더미 공고(`__danggeun_system__` / `__baemin_system__`) 멱등 보장. job_candidates 생성에 필요. |
| `baemin-triage.ts` | Haiku 4.5 분류기 — 미매칭 SMS가 배민 지원인지 판단 + 이름·지점·시간 파싱. 하드 스팸 필터 포함. |
| `usage.ts` | Claude 응답 usage → `ai_usage_daily` 테이블 적재 + `messages` 토큰 컬럼용 헬퍼. |

## 모델 사용처

- **Sonnet 4.6** — screening / onboarding / exploration / active의 복수 공고 상담 / 공고 생성·추출
- **Haiku 4.5** — 배민 triage (저비용 분류)

## "확정 뉘앙스 절대 금지"

전 stage 공통 룰. 지원자가 정보를 보내도 그게 곧 근무 확정/배정을 의미하지 않음. 매니저가 별도로 확정. 자세한 건 [docs/기능설명서.md](../../docs/기능설명서.md) §3.

## 여러 공고를 함께 묻는 경우

진행 중인 SMS에서 여러 노출 공고를 함께 비교할 수 있다. 모델은 안내할 항목과 원문만 고르며 조건 값은 서버가 공고 데이터에서 구성한다. 관심·가능 시간은 관리자 타임라인의 **지원자 상담 발언**으로 남긴다. 다른 공고의 후보 생성·체크리스트 진행·근무 확정은 하지 않는다.

대상이 모호하면 되묻고, 조건 누락이나 검증 실패는 관리자 확인으로 넘긴다. 코파일럿에서는 관찰 제안만 초안에 표시하며 자동 기록하지 않는다. 직전 복수 공고 안내 뒤의 짧은 긍정은 현재 공고 진행으로 단정하지 않는다. 아직 진행 중인 후보가 없거나 모두 중단된 경우는 기존 진입·관리자 처리 흐름을 유지한다.

검증 범위와 배포 순서: [복수 상담 eval](../../.ai/multi-job-consultation/eval.md). PR129의 선행 대화 선택 DB 마이그레이션이 필요하며, 운영 발송 전 통제된 실문자 검수를 거친다.
