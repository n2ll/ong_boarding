# `lib/` — 공통 라이브러리

서버·클라이언트 양쪽에서 import하는 유틸리티들. 외부 서비스 어댑터·도메인 헬퍼·AI 시스템.

## 파일별 책임

| 파일 | 역할 |
|---|---|
| `supabase.ts` | Supabase 클라이언트 — `getBrowserClient()` (브라우저, anon key) / `createServiceClient()` (서버, service role) |
| `claude.ts` | Anthropic API 직접 호출 — 공고 생성(`generateJobPosting`) / 추출(`extractJobInfo`). 둘 다 optional supabase 인자 받으면 ai_usage_daily에 비용 적재 |
| `solapi.ts` | SOLAPI(SMS/알림톡) 발송. `sendSms` / `sendAlimtalk` / `sendNotification`(알림톡 우선 + SMS 폴백) |
| `slack.ts` | Slack 알림 — 매니저 인계·온보딩 준비 완료·전화 인계 등. `SLACK_WEBHOOK_URL` 없으면 no-op |
| `kakao-geocode.ts` | 카카오 지도 API로 주소 → 위경도. apply 폼·매니저 등록 시 사용 |
| `scoring.ts` | 추천 받기용 후보 점수 계산 — 거리·차량 보유·최신성 가중치 |
| `applicant-source.ts` | source 키(`danggeun`/`baemin`/`manual` 등) → 한글 라벨 매핑 |
| `agent.ts` | 옛 단일 에이전트 엔트리포인트 — 신규 코드는 `agent/router.ts` 사용 (이 파일은 레거시 호환용) |
| `agent/` | 단계별 AI 응대 엔진 — 자세한 건 [agent/README.md](agent/README.md) |

## 핵심 진입점

| 시나리오 | 시작 함수 |
|---|---|
| 인입 SMS 처리 | `agent/router.ts` → `runAgentForCandidate` |
| 단계 전이 부수효과(자동 발송 등) | `agent/transitions.ts` → `applyTransition` |
| 미매칭 SMS 분류 | `agent/baemin-triage.ts` → `triageInbound` + `isHardSpam` |
| 자동 발송 멘트 조회 | `agent/system-messages.ts` → `getSystemMessage` |
| 톤·운영정보 프롬프트 빌드 | `agent/examples.ts` → `buildToneGuide` |
| 추천 후보 ranking | `scoring.ts` → `rankCandidates` |

## 환경변수 사용처

코드에서 `process.env.*`로 직접 접근. 키 목록은 [docs/기능설명서.md](../docs/기능설명서.md) §9.
