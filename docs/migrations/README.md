# DB 마이그레이션

Supabase SQL Editor에서 한 번씩 실행. 대부분 멱등(`IF NOT EXISTS` / `CREATE OR REPLACE`) — 재실행 안전.

## 적용 순서

날짜순으로 적용하면 됨. 이미 적용된 항목은 멱등이라 영향 없음.

| 파일 | 영향 | 멱등? |
|---|---|---|
| `2026-05-prompt-examples.sql` | `prompt_examples` 테이블 신설 | ✅ |
| `2026-05-prompt-examples-facts.sql` | `facts` 카테고리 추가 | ✅ |
| `2026-05-prompt-examples-system-message.sql` | `system_message` 카테고리 추가 | ✅ |
| `2026-05-jc-stage-check.sql` | `job_candidates.chk_jc_stage` 완화 | ✅ |
| `2026-05-branches-slot-capacity.sql` | `branches.slot_capacity` JSONB | ✅ |
| `2026-05-applicant-cascade.sql` | applicants 삭제 시 종속 테이블 CASCADE | ✅ |
| `2026-05-seed-system-messages.sql` | system_message 시드 | ✅ |
| `2026-05-status-rename.sql` | status 단계명 통일 1차 | ⚠️ 1회용 (UPDATE) |
| `2026-05-backfill-danggeun-job-candidates.sql` | 기존 당근 후보 백필 | ⚠️ 1회용 |
| `2026-05-onboarding-complete-backfill.sql` | 온보딩 완료 백필 | ⚠️ 1회용 |
| `2026-06-messages-classification.sql` | messages.classification 컬럼 (인박스용) | ✅ |
| `2026-06-status-final-rename.sql` | 최종 6종 상태로 리네임 (스크리닝 전/중/완료, 확정인력, 대기자, 부적합) | ⚠️ 1회용 |
| `2026-06-bulk-complete-existing-danggeun.sql` | 기존 당근 후보 일괄 완료 처리 | ⚠️ 1회용 — 과도해서 즉시 revert |
| `2026-06-revert-bulk-complete.sql` | 위 SQL revert (메시지 마커 기반 정정) | ⚠️ 1회용 |
| `2026-06-ai-usage-tracking.sql` | AI 토큰 추적 — messages 토큰 컬럼 + `ai_usage_daily` + upsert RPC | ✅ |
| `2026-06-sms-cost-tracking.sql` | SMS 발송 비용 추적 — `sms_type`/`sms_cost_krw` + 자동 분류 트리거 + 통합 비용 view | ✅ |

## 파일 작성 규칙

- 파일명: `YYYY-MM-{slug}.sql` (날짜는 작업 시작일 기준)
- 첫 줄: `-- {간단 설명}` + `-- ----` 구분선
- 그 다음 줄에 상세 의도·영향·1회용/멱등 여부 명시
- `ALTER TABLE` 같은 스키마 변경은 `IF NOT EXISTS` / `IF EXISTS` 우선 사용

## 백필 SQL 작성 팁

- TEMP TABLE 사용 X — Supabase SQL Editor는 statement마다 세션이 다를 수 있음 (`relation does not exist` 에러 가능)
- 대신 CTE(`WITH`) 또는 inline subquery 사용
- UPDATE 전에 `SELECT COUNT(*)` 같은 dry-run으로 영향 범위 먼저 확인

## 환경

| 환경 | 어디서 실행 |
|---|---|
| 개발 | 로컬에서 Supabase CLI 또는 Supabase Studio |
| 프로덕션 | Supabase Studio (Vercel과 연결된 프로젝트) → SQL Editor |

## 비용 추적 관련 view

```sql
-- 일별 통합 비용 (AI + SMS, KRW 환산)
SELECT * FROM usage_daily_cost ORDER BY day DESC LIMIT 30;

-- 메시지별 비용 디테일
SELECT created_at, direction, sent_by, sms_type, sms_cost_krw, model, tokens_in, tokens_out
FROM messages ORDER BY created_at DESC LIMIT 50;
```
