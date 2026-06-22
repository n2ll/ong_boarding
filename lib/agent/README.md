# `lib/agent/` — AI 응대 엔진

지원자 SMS에 자동 응답하는 Claude 기반 에이전트 시스템. 인입 1건 = 단계 모듈 1회 호출 = Claude API 1회 호출.

## 흐름 한눈에

```
인입 SMS → router.runAgentForCandidate
  ├─ job_candidates 로드 → 현재 stage 결정
  ├─ stage.process() → Claude 호출 → reply_text + transition + checklist 갱신
  ├─ SOLAPI 발송 → messages INSERT (토큰 비용 포함)
  └─ transitions.applyTransition() → status 갱신 + 자동 발송(GUIDE 등) + Slack
```

## 파일별 책임

| 파일 | 역할 |
|---|---|
| `router.ts` | 진입점. stage 라우팅 + 응답 발송 + transition 처리. 1분 텀(coalesce) 로직 포함. |
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

- **Sonnet 4.6** — screening / onboarding / exploration / 공고 생성·추출
- **Haiku 4.5** — 배민 triage (저비용 분류)

## "확정 뉘앙스 절대 금지"

전 stage 공통 룰. 지원자가 정보를 보내도 그게 곧 근무 확정/배정을 의미하지 않음. 매니저가 별도로 확정. 자세한 건 [docs/기능설명서.md](../../docs/기능설명서.md) §3.
