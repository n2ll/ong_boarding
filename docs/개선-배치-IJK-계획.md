# 개선 배치 I·J·K 계획 (2026-07-13)

> 2026-07-13 백로그 메모 10개 항목을 코드베이스 대조로 검토한 결과와, 첫 구현 범위로 확정한 배치 I·J·K의 상세 설계.
> **상태: 배치 I·J 미착수 / 배치 K 일부 구현(2026-07-16 — 아래 '진행 현황' 참조).** 착수 시 이 문서를 실행 스펙으로 쓰되, **배치 K는 갱신된 현황을 우선**한다.

---

## 🔄 진행 현황 업데이트 (2026-07-16)

**외부 DB 연동 Phase 1 착수 완료** — 배치 K의 상당 부분이 구현됐고, 원래 계획과 달라진 점이 있다.

- **K-0(원격 스키마 디스커버리) 완료 — 단 전제 수정.** TMS는 **Supabase가 아니라 AWS RDS Postgres**(`onggoing_prod`)였다. 계획의 `TMS_SUPABASE_URL`·PostgREST OpenAPI 방식 대신 **`TMS_DB_*`(pg 드라이버) + scratchpad pg 스크립트(읽기전용, PII 마스킹)** 로 스키마 확정 — 16 tables(user·schedule·delivery·company·location 등). 매칭키=전화. **별도 '라인' 테이블 없음**(라인=화주사별 schedule/delivery 반복 패턴 파생).
- **K-1(활동중 배송원 신호) 완료 — 단 설계 변경.** 계획의 `ongmanaging_active` 캐시가 아니라 **`tms_active_*` 캐시**로 구현했다: 옹매니징(계약·정산)은 **실시간 유지**, 옹고잉 TMS(실배차 schedule)를 **일 1회 cron 캐시**(Vercel→AWS 매요청 회피). 신규 `lib/tms.ts`(pg)·`app/api/admin/cron/tms-sync`·마이그레이션 `2026-07-tms-active-cache.sql`(3-상태 NULL 보존). `active-check` 병합으로 기존 Pipeline 배지·제외필터·벌크제외가 자동 커버 + 상세패널 '활동 중(옹고잉)' 배지. (적대적 리뷰 후 빈결과 가드·페이지네이션·에러 마스킹 경화.) 실데이터 검증: applicants 642 중 활동 10명.
- **K-2(정산 요약)·K-3(공고 프리필: 화주사/라인) 미구현** — 다음 단계.
- **신규 방향(2026-07-16)**: 옹매니징·TMS에서 **인력 정보·화주사 정보도 반입**(배송라인은 필요 시)로 확장 요청 = K-2/K-3 확장. 단 **개인정보 반입**은 기존 'PII 미반입' 원칙과 충돌하므로, **재활용 레인 설계(수신동의·블랙리스트·최소 필드)와 함께 별도 확정** 후 진행.
- **블랙리스트 정의(2026-07-16)**: "절대 재채용 불가"(노무 이슈·커뮤니케이션 핏 문제) = 매니저 지정 영구 제외. `status` 자동 도출 불가 → **phone-keyed 별도 저장** 필요.

> **정정**: §0·§4의 "TMS = Supabase/PostgREST"·`TMS_SUPABASE_URL` 전제는 폐기(실제 = AWS RDS Postgres, env `TMS_DB_*`, `pg` 드라이버). §4 K-1의 `ongmanaging_*` 컬럼명도 실제 구현은 `tms_active_*`.

---

## 0. 공통 원칙 — MCP vs 런타임 어댑터

- **MCP는 개발 세션 전용 도구다.** 프로덕션 앱 런타임은 MCP를 쓸 수 없다.
- 옹매니징·옹고잉 TMS 등 외부 DB의 런타임 접근은 전부 `lib/ongmanaging.ts` 패턴으로 통일한다: **env 기반 읽기 전용 service 클라이언트** + 테이블명 env 오버라이드 + 미구성 시 안전 스킵(`configured:false`).
- MCP는 스키마 파악(디스커버리)에만 쓴다. 현재 개발 세션의 Supabase MCP는 옹보딩 자체 DB에 연결돼 있으므로, TMS/옹매니징 스키마 확인은 K-0 스크립트(또는 해당 프로젝트 MCP 추가 연결)로 한다.
- 시크릿(비밀번호·서비스 키)은 `.env.local`·Vercel env에만. 이 문서를 포함해 코드/문서/커밋에 실제 값 금지.

---

## 1. 메모 항목별 검토 요약

| # | 메모 항목 | 현황 (코드 대조) | 처리 |
|---|---|---|---|
| 1 | 미분류문자함·옹매니징 이관 명칭 | "이관"은 실제로 아무것도 이관 안 함 — `classification='ongmanaging'` 태깅 + AI 응대 제외가 전부. 이름이 기능을 과장 | **배치 I-1** (라벨만 변경) |
| 2 | Auth 폼 + 공용 계정 | HTTP Basic Auth(`middleware.ts`)뿐. Supabase Auth·로그인 페이지 없음 | **배치 I-2** |
| 3 | 에이전트 비용 월 단위 집계/예상 | `ai_usage_daily` + `usage_daily_cost` 뷰(AI+SMS 일별) + 당월 집계 API + AgentBrain 카드까지 존재. 월별 히스토리·예상치·SMS 포함 합계만 없음 | **배치 I-3** |
| 4 | 온톨로지/지식 기반 | 이미 하드코딩 아님 — `prompt_examples`·`branches.ai_facts` DB 기반, 어드민 편집 가능. RAG/임베딩 0건. 현 규모에서 벡터 RAG는 과투자. 병목은 검색 기술이 아니라 **지식 유입**(슬랙/채널톡/CS 미연동) | 보류 — §5.1 방향만 기록 |
| 5 | 공고 초안에 화주사/배송라인 정보 | AI 초안 생성(`generate-posting`)·`clients` 테이블 존재. 옹매니징/TMS의 라인 데이터 스키마 미확인 | **배치 K-3** (K-0 게이트 후) |
| 6 | 활동중 배송원 분류/표기 | `checkOngmanagingActive()`가 재컨택 제외용으로만 존재(온디맨드). 인재풀 상시 배지/필터 없음 | **배치 K-1** |
| 7 | 타겟 공고 노출 | pull 페이지(`/p/[token]`)는 모든 active 공고를 전원 노출. 후보 단위 타게팅 없음 | **배치 J** |
| 8 | 캠페인 (내부 확장/외부) | 내부 재컨택 + 퍼널 통계 완비. "사람 더 모으기" = 리퍼럴 캠페인이 유력하나 미구현·설계 필요. 외부는 당근 정책 보류, AI 3채널 초안 수동 게시 유지 | 보류 — 설계 논의 필요 |
| 9 | 운행기록 대체 (정산/계약 기반) | "정산=이행의 ground truth" 원칙과 일치. `monthly_settlements` 조회 어댑터 존재 | **배치 K-2** |
| 10 | 긴급 백업 (옹매니징 배송원 컨택) | 현행 로직과 반대 방향(활동자는 캠페인 제외). 스케줄 데이터 유무 미확인 + 수신동의 맥락 상이 | 보류 — K-0 디스커버리 결과 보고 재논의 |

### §5.1 지식 기반 방향 (보류 항목 기록)
1. **지금**: "옹고잉/내이루리가 뭔가", CS 대응 원칙 등 회사 지식을 `prompt_examples` facts로 정리 (연동 불필요, 즉시 가능)
2. **다음**: 슬랙/채널톡 로그 → AI 추출 → **매니저 승인** → `prompt_examples` 적재하는 "지식 증류 파이프라인" (자동 적재 금지 — 오염 위험)
3. **코퍼스 수백 건 초과 시**: Supabase 네이티브 pgvector 또는 에이전틱 검색(Claude가 지식 테이블을 tool로 직접 검색) — 임베딩 파이프라인 없이 시작 가능한 후자 우선 검토

---

## 2. 배치 I — 빠른 승리 3종

### I-1. 라벨 리네이밍
마이그레이션·env 없음. DB 값 `classification='ongmanaging'`·API action 파라미터 **불변** (레이블만).

- "미분류 문자함" → **"분류 대기 문자함"**
  - `components/Sidebar.tsx:64`, `components/Inbox.tsx:97`, `components/Topbar.tsx:239`, `components/Dashboard.tsx:227·332`, `components/Automation.tsx:131`, `app/(admin)/layout.tsx:16`, `app/api/admin/notifications/route.ts:57`, `lib/automation.ts:41·239`
- "옹매니징 이관" → **"기존 계약자 문의로 분류"** — `components/Inbox.tsx:44-46·73·157` (모달 제목/설명/확인 버튼/토스트/액션 버튼)
  - 설명 문구: "옹고잉 재직자·기존 계약자 문의로 표시합니다. AI 응대 대상에서 제외돼요."
  - 선택: `app/api/admin/inbox/[id]/classify/route.ts:73` raw_payload note 문구
- **변경 금지**: `components/Pipeline.tsx`·`lib/ongmanaging.ts`·`app/api/admin/ongmanaging/*`의 "옹매니징" 문자열은 실제 시스템 연동 지칭.

### I-2. Supabase Auth 로그인 (Basic Auth 클린 컷)
- `npm i @supabase/ssr`. 새 env 없음. DB 마이그레이션·RLS 변경 없음 — anon/authenticated 전면 차단(rls-lockdown) 유지. 클라이언트의 Supabase 직접 접근은 broadcast Realtime(`live-console` 토픽)뿐이라 무영향.
- `lib/supabase.ts`: `getAuthBrowserClient()` 추가(쿠키 기반). 기존 `getBrowserClient()`·`createServiceClient()` 불변.
- `app/login/page.tsx` 신규 — `(admin)` 그룹 **밖**(어드민 레이아웃 미적용). 한국어 폼, shadcn Card/Input/Button, `signInWithPassword` → `?next` 리다이렉트. `useSearchParams`는 Suspense 경계 필요.
- `middleware.ts` 재작성: `@supabase/ssr` 표준 미들웨어 패턴 — `getAll`/`setAll` 갱신 쿠키를 request·response **양쪽**에 기록(어기면 로그아웃 루프), `getUser()` 검증. 미인증 API → 401 JSON, 페이지 → `/login?next=`. `PUBLIC_API_PREFIXES`(`/api/admin/cron` Bearer 자체 인증 포함)·`/apply`·`/p` 공개 유지 + `/login` 추가. production에서 Supabase env 미설정 시 503 fail-closed 유지.
- `components/Sidebar.tsx` 프로필 블록(~133-141)에 로그아웃 버튼. 선택: `lib/swr.ts` jsonFetcher가 401이면 `/login` 이동.
- 클린 컷 근거: 내부 소수 사용자, Basic Auth 머신 콜러 없음(grep 확인), 병행 시 보안 표면·분기 복잡도만 증가.
- **계정 준비(코드 밖, 매니저 수행)**: Supabase 대시보드 → ① Authentication에서 "Allow new users to sign up" **OFF** ② `info@naeyil.com` 계정 생성(Auto Confirm). 비밀번호는 대시보드에서만 입력 — 어디에도 기록 금지. ※ 초기 공유된 비밀번호는 채팅에 노출됐으므로 **다른 값으로 설정**할 것.
- 배포 순서: preview에서 전체 검증 → production → 마지막에 `ADMIN_USER`/`ADMIN_PASSWORD` env 삭제 → 팀에 "/login에서 로그인" 공지.
- 공용 계정 한계: 감사추적 불가 — 파일럿 수용, 추후 개인 계정 추가 용이한 구조.

### I-3. 월별 비용 집계 + 월말 예상
마이그레이션·env·패키지 없음.

- `app/api/admin/usage/route.ts`: `usage_daily_cost` 뷰에서 최근 6개월 조회(KST 월초 계산 — 기존 `kstMonthStart` +9h 패턴, `.limit(30)` 미적용) → 서버에서 `day.slice(0,7)` 월별 합산. 응답 필드 추가(기존 `data`·`month` 유지 → `Reports.tsx` 무영향):
  - `months[]`: `{ month, ai_cost_krw, sms_cost_krw, total_cost_krw }` × 6 (빈 달 0 채움)
  - `projection`: `{ month, mtd_krw, projected_krw, elapsed_days, days_in_month }` — 예상치 = 누적 ÷ 경과일 × 말일수
- `components/AgentBrain.tsx` "이번 달 AI 사용량" 카드(~1201-1256) 확장: 이번 달 AI+문자 합계 + 월말 예상 한 줄 + 최근 6개월 컴팩트 리스트. 각주: "환율 1,400원 가정 · 월초에는 예상치 변동이 커요."
- KST 계산은 반드시 서버(+9h 보정) — Vercel UTC 오차 방지. `elapsed_days` 최소 1.

---

## 3. 배치 J — 타겟 공고 노출

**설계 요지**: `jobs.exposure`(`'all'`/`'targeted'`) 컬럼 신설 + 타겟 명단은 **기존 `job_candidates` 행 재사용**. 신규 테이블·신규 관리 UI 없음 — 공고 후보 보드의 "인재풀에서 후보 추가" 피커가 곧 노출 대상 관리. 게이트는 `recruit_mode`와 AND 결합.

- `recruit_mode` 오버로드 금지 이유: pull GET·interest 게이팅·에이전트 일반 라인 판별 3곳에 살아있는 동작 + `Jobs.tsx:195` `asRecruitMode()`가 미지 값을 `external`(공개)로 폴백 → 새 값 삽입 시 위험 방향 실패.
- 마이그레이션 신규 `docs/migrations/2026-07-jobs-exposure.sql` (멱등, text+check 하우스 패턴, default `'all'`로 기존 공고 동작 불변):
  ```sql
  alter table public.jobs add column if not exists exposure text not null default 'all';
  alter table public.jobs drop constraint if exists jobs_exposure_check;
  alter table public.jobs add constraint jobs_exposure_check check (exposure in ('all','targeted'));
  ```
- `app/api/pool/[token]/route.ts` (GET): jobs select에 exposure 추가, 리스트 필터에 `exposure !== 'targeted' || allowedJobIds.has(id)`. exposure는 응답에 내리지 않음.
  - **필수 동반 보정 — `interested` 산식**: 현재 "jc 행 존재"만 보므로 피커로 추가된 타겟 전원이 "✓ 접수됐어요"로 잠겨 기능 무력화(+본인이 안 한 접수 표시). → jc 참여 마커(`sent_at`/`responded_at`/`contacted_at`/`agent_stage` 중 NOT NULL) 또는 `pool_events(interest_click)` 기준으로 교체. 전 마커 NULL인 순수 피커 행만 관심 버튼 활성.
- `app/api/pool/[token]/interest/route.ts`·`notify/route.ts`: targeted 공고면 jc 행 존재 확인, 없으면 기존과 동일한 불투명 400("모집이 마감된 공고예요") — 공고 존재 노출 방지.
- `app/api/admin/jobs/route.ts`(목록 select·POST)·`app/api/admin/jobs/[id]/route.ts`(`ALLOWED_PATCH_FIELDS`+값 검증): exposure 추가 — recruit_mode 처리 패턴 복제.
- `components/Jobs.tsx`: 타입/생성 폼/수정 모달에 노출 범위(전체 노출/지정 대상만) 선택, 공고 카드에 "지정 노출" 배지, 후보 패널 헤더에 힌트 1줄("지정 노출 공고: 아래 후보 명단만 맞춤 공고 페이지에서 이 공고를 봅니다"). **확정 뉘앙스 금지** — "노출 대상"이지 배정·확정이 아님. `Pipeline.tsx` 무변경.
- 엣지 케이스: all↔targeted 전환 시 과거 관심 클릭자는 jc 행 보유로 계속 노출(참여자 증발 없음); 비대상에게 발송된 맞춤링크는 해당 공고만 조용히 숨김(활성 0건이면 기존 빈 상태 카드); 시스템 공고(`__danggeun_system__`·`__baemin_system__`)는 기존 title 필터로 무관.

---

## 4. 배치 K — 옹매니징/TMS를 '제외 필터'에서 '정보원'으로

**순서**: K-0 디스커버리(**하드 게이트**) → K-1+K-2(같은 cron·같은 마이그레이션) → K-3(라인 테이블 소재 확정 후).

### K-0. 원격 스키마 디스커버리
- `scripts/discover-remote-schema.ts` 신규 — **gitignored**(`.gitignore`에 `/scripts/` 추가). `.env.local` 직접 파싱, PostgREST OpenAPI 스펙(`GET {URL}/rest/v1/` + service key)으로 테이블·컬럼·타입 추출 + 행수 + **PII 마스킹** 샘플. **stdout 전용, 파일 미생성**. 실행: `npx tsx scripts/discover-remote-schema.ts`.
- 대상: 옹매니징(기존 `ONGMANAGING_*` env) + TMS(신규 `TMS_SUPABASE_URL`/`TMS_SERVICE_ROLE_KEY`).
- 리뷰 게이트에서 확정: ① 화주사 테이블 ② 배송라인/스케줄 테이블 ③ worker↔line 배정 관계 ④ settlements 금액 컬럼(=복사 금지 목록) ⑤ TMS 운행 이벤트 유무(메모 #10 재논의 근거).

### K-1. 활동중 배송원 분류/표기
- 마이그레이션 신규 `docs/migrations/2026-07-applicants-ongmanaging-signals.sql`:
  `ongmanaging_active BOOLEAN`(NULL=미대조 — **3-상태, false로 뭉개지 않기**), `ongmanaging_active_reasons TEXT[]`, `ongmanaging_checked_at TIMESTAMPTZ`, + K-2용 `ongmanaging_settled_months INT`, `ongmanaging_last_settled_month TEXT`.
- cron 신규 `app/api/admin/cron/ongmanaging-sync/route.ts` — airtable-sync 패턴 복제(`requireCronAuth` Bearer·`force-dynamic`·`?dry=1`). **미구성 시 `skipped:true` + 기존 캐시 값 보존**. 전화번호 정규화 매칭 → 그룹 벌크 UPDATE. `vercel.json`에 daily 스케줄(KST 아침).
- UI: `app/api/admin/applicants/route.ts` LIST_COLUMNS + `app/api/admin/jobs/[id]/candidates/route.ts` select에 컬럼 추가 → Pipeline 배지("옹매니징 활동중", reasons 툴팁)+필터 토글, Jobs 후보 카드 배지.
- **기존 발송 직전 실시간 active-check는 유지** — 이중 방어. 캐시 컬럼은 브라우징/필터/배지용, 발송 가드는 실시간.

### K-2. 정산 이력 요약 (운행기록 대체 — 같은 cron에서 캐시)
- `lib/ongmanaging.ts` 확장: `fetchSettlementSummariesByPhone(): Map<phone, { monthsSettled, lastSettledMonth }>`.
- `select("worker_id, year, month")`만 — **정산 금액·계좌 컬럼은 select 자체 금지**(파생값만 옹보딩에 저장). settlements 전체 조회는 `.range()` 페이지네이션 필수(supabase 기본 1000행 제한).
- 표시: Pipeline 상세 + Jobs 후보 카드 "정산 N개월 · 최근 YYYY-MM". 신뢰점수 산식 반영은 스코프 밖(표기만).

### K-3. 공고 초안에 화주사/배송라인 주입
- 마이그레이션 신규 `docs/migrations/2026-07-clients-ongmanaging-key.sql`: `clients.ongmanaging_shipper_key TEXT`(수동 세팅; 이름 ilike 매칭은 fallback).
- 어댑터 `lib/tms.ts` 신규(K-0 결과 라인 데이터가 옹매니징에 있으면 `lib/ongmanaging.ts` 확장으로 대체 — 시그니처 동일): `fetchDeliveryLinesForClient({ shipperKey, clientName }): DeliveryLineInfo[]` (lineName·region·pickupAddress·schedule·vehicleType·workerCount), env 테이블명 오버라이드 + `isTmsConfigured()`.
- `app/api/admin/jobs/generate-posting/route.ts`: body에 `client_id?` 추가 → 라인 최대 ~15개를 `[참고: 배송라인 현황]` 블록으로 프롬프트에 concat. **~5s 타임아웃 fail-open** — 초안 생성을 절대 막지 않음(mock 폴백 경로 불변). 신규 Claude 호출 없음 → `ai_usage_daily`는 기존 `purpose:"job_generate"` 유지.
- `components/Jobs.tsx`: `handleGenerateJD`(~592행)에 `client_id` 전달, 응답 `lines` 있으면 "배송라인 N개 반영됨" 힌트 + `pickup_address` **비었을 때만** 첫 라인 상차지 프리필(기존 "비운 필드만" 패턴). 매니저 최종 확인 — 자동 확정 없음.

### 배치 K 리스크
1. 전화번호 매칭 품질(번호 변경·법인폰) → 캐시는 표시용, 발송 가드는 실시간 체크 이중 방어 + `checked_at`으로 신선도 노출
2. 원격 스키마 드리프트 → env 테이블명 오버라이드, cron 실패는 에러로 로그(조용한 실패 금지)
3. generate-posting 지연 → 타임아웃 캡 + fail-open
4. PII/금액 → 옹보딩에 저장되는 건 boolean/개월 수/월 라벨 파생값뿐

---

## 5. 실행 순서 · 선행 액션 · 검증

### 실행 순서
1. **배치 I**: I-1(무위험) → I-3 → I-2(preview 검증 → production → env 삭제)
2. **배치 J**: 마이그레이션 → 어드민 API → pool GET(+interested 보정) → interest/notify 게이트 → Jobs UI
3. **배치 K**: K-0 실행·팀 리뷰 게이트 → K-1+K-2 → K-3
- 배치별 PR 단위 커밋, `npm run build` 필수(레포 무테스트 원칙 — 영향 경로 수동 확인).

### 선행 액션 (매니저)
- [ ] Supabase 대시보드: 신규 가입 차단 + `info@naeyil.com` 계정 생성 (I-2 전)
- [ ] `.env.local` + Vercel: `TMS_SUPABASE_URL`/`TMS_SERVICE_ROLE_KEY` 투입 (K-0 전)
- [ ] K-0 리포트 리뷰 후 테이블명 확정 (K-3 전)

### 검증 체크리스트
- **공통**: `npm run build`, 마이그레이션 2회 실행 멱등 확인
- **I**: /inbox 문구·사이드바·알림벨·대시보드 문구 / Pipeline의 옹매니징 대조 문구 **불변** / 분류 후 DB `classification='ongmanaging'` 유지 / 비로그인 → /login 리다이렉트, API 401, cron Bearer 정상, /apply·/p 무인증, 로그아웃 / /brain 월별 6줄·이번 달 합계·예상치
- **J**: 타겟 지원자의 /p/[token]에 공고 노출 + 관심 버튼 **활성**(✓ 아님) / 비대상에겐 미노출 + interest POST 400 / 기존 참여자(클릭·발송·지원) ✓ 유지 / all↔targeted 왕복 / 당근·배민 시스템 공고 무영향
- **K**: cron dry-run·401·미구성 시 값 보존 / 배지·필터 수치 = 실시간 active-check 결과 일치 / generate-posting 미구성 시 현행과 동일 동작 / `git status` clean(디스커버리 스크립트 미커밋)
