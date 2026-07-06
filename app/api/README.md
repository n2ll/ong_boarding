# `app/api/` — REST API 라우트

Next.js App Router의 route handlers. 모두 `route.ts` 파일.

## 공개 엔드포인트

| 경로 | 메서드 | 용도 |
|---|---|---|
| `/api/apply` | POST | 지원 폼 제출 — applicants INSERT/UPDATE, 시작 멘트 SMS, job_candidates 생성 |
| `/api/branches` | GET | 활성 지점 리스트 (apply 폼에서 호출) |

## 인입 SMS 진입점

| 경로 | 메서드 | 용도 |
|---|---|---|
| **`/api/webhooks/supabase-new-message`** | POST | **현재 메인** — Supabase Database Webhook으로 트리거. messages INSERT 후 매칭/triage/agent 분기 |
| `/api/messages/inbound` | POST | (구) SMS Gateway 직접 호출용. 현재 사용 X (webhook으로 대체) |

→ 자세한 흐름은 [webhooks/README.md](webhooks/README.md)

## Cron

| 경로 | 스케줄 | 용도 |
|---|---|---|
| `/api/admin/cron/onboarding-reminder` | `0 * * * *` | 온보딩 미회신 후보 매시간 점검 — 24h 리마인더 SMS + 3h 후 매니저 인계 슬랙 |

`vercel.json`에서 등록.

## 어드민 API (`/api/admin/*`)

대시보드 UI에서 호출. 모두 service-role로 동작.

### 지원자 / 메시지
- `applicants/` — 수기 등록/편집 (모달 폼)
- `messages/[applicantId]/` — 특정 지원자 메시지 히스토리
- `messages/send/` — 매니저 직접 발송 (대화창 입력)
- `messages/bulk-send/` — 추천 후보 일괄 시작 멘트 발송
- `drafts/[id]/` — AI 초안 승인/거절
- `ongmanaging/active-check/` — 재컨택 전 옹매니징(별도 Supabase) 활성 계약 대조 — 미구성 시 `configured: false` 200

### 에이전트 제어
- `agent/test/` — 단일 인입 테스트 (실 발송 X)
- `agent/pause/` — stage='paused' + Slack 알림
- `agent/resume/` — 직전 stage 복귀
- `agent/set-stage/` — 매니저 수동 단계 변경 (이전 단계 체크리스트 자동 채움)
- `agent/draft/` — outbound 초안 미리보기 (실 발송 X)
- `agent/danggeun/impersonate/` — 연습용 — 지원자 빙의로 inbound 입력 + AI 자동 응답
- `agent/danggeun-practice/reset/` — 연습 데이터 일괄 삭제
- `agent/playground/` — 공고+가짜 지원자 시뮬레이션

### 미분류 인박스
- `inbox/pending/` — `classification='pending'` 메시지 목록
- `inbox/[id]/classify/` — 매니저 직접 분류 (baemin/other)

### 공고 / 추천
- `jobs/`, `jobs/[id]/` — 공고 CRUD
- `jobs/[id]/dispatch/` — 공고 → 추천 후보에게 일괄 발송
- `jobs/[id]/candidates/` — 공고 후보 풀
- `recommend/` — 공고 텍스트 → 픽업 주소 추출 + 후보 ranking
- `recommend/generate/` — 거친 메모 → 공고문 생성 (Claude)

### 관리
- `branches/`, `branches/[id]/` — 지점 CRUD + 슬롯 정원
- `site-managers/`, `site-managers/[id]/` — 현장 매니저 CRUD
- `prompt-examples/`, `prompt-examples/[id]/` — 톤·운영정보·시스템 메시지 CRUD
- `heartbeat/` — SMS Gateway 안드로이드 앱 상태 보고

## 공통 규칙

- 모두 `force-dynamic` (캐시 X)
- 서버에서 `createServiceClient()` 사용 (RLS 우회)
- Claude 호출이 있는 라우트는 응답에서 `usage`를 받아 `ai_usage_daily`에 적재 — [lib/agent/usage.ts](../../lib/agent/README.md)
- 발송이 있는 라우트는 SOLAPI 호출 후 messages INSERT — 트리거가 sms_type/cost 자동 채움
