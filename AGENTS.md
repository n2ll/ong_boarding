# AGENTS.md — 옹보딩(Ongboarding)

이 저장소에서 AI 에이전트가 작업할 때의 핵심 가이드. 상세 규칙은 `.cursor/rules/`에, 도메인/기능 설명은 `docs/기능설명서.md`에 있다.

## 제품
시니어(50~70대) 긱워커 채용에 특화된 B2B SaaS 채용 관리 플랫폼.
- 지원자: 앱·폼 없이 **SMS/채팅(옹봇)** 으로 채용 완료.
- 매니저: 반복 업무를 **AI 에이전트가 대행**, 어드민 대시보드로 관리.

## 스택
Next.js 14 (App Router) · React 18 · TypeScript(strict) · Tailwind v4 · Radix/shadcn(+일부 MUI) · Supabase · Anthropic Claude · SOLAPI/Slack/지오코딩. 배포 Vercel. alias `@/*`.

## 작업 4원칙 (카파시 기반)
1. **생각 먼저** — 추측 금지, 모호하면 질문, 트레이드오프 제시.
2. **단순함 우선** — 요청한 최소 코드만. 투기적 추상화·옵션 금지.
3. **외과적 변경** — 필요한 줄만. 무관한 리팩터링/포맷 변경 금지. 기존 스타일 준수.
4. **목표 기반 실행** — 검증 가능한 성공 기준 설정 후 반복. (이 repo는 테스트가 없으니 보통 `npm run build`+타입+영향 경로 수동 확인)

## 절대 규칙
> **확정 뉘앙스 금지** — 지원자가 정보를 보내거나 긍정해도 근무 확정/배정이 아니다. 확정은 매니저가 한다. AI 응대·문구·로직에서 이를 절대 어기지 말 것.

## 디렉토리
- `app/(admin)/` 어드민 대시보드 · `app/apply/` 지원 폼 · `app/api/` 라우트(+`webhooks/`)
- `components/`(+`ui/` shadcn) · `lib/`(어댑터·헬퍼) · `lib/agent/`(Claude 응대 엔진)
- `docs/migrations/` SQL 마이그레이션

## 자주 보는 문서
`PRODUCT_DIRECTION.md` · `docs/기능설명서.md` · `lib/README.md` · `lib/agent/README.md` · `app/api/README.md` · `app/api/webhooks/README.md`

## 핵심 컨벤션 요약
- Supabase: 클라이언트=`getBrowserClient()`(anon), 서버=`createServiceClient()`(service role, 서버 전용).
- API 라우트: `force-dynamic`. Claude 호출 시 `ai_usage_daily` 적재. 발송 후 `messages` INSERT.
- UI: 토큰(`styles/theme.css`) 사용, `focus-visible` 유지, 파괴적 액션은 확인 모달, 알림은 Sonner 토스트.
- 에이전트 stage: `exploration → screening → onboarding → active`(+`paused`/`abort`). 모델은 응대=Sonnet 4.6 / 분류=Haiku 4.5.
- 마이그레이션: `YYYY-MM-설명.sql` 누적 추가. 기존 파일 사후 수정 금지.
- 시크릿은 `.env.local`에만. 문서/코드/커밋에 실제 값 금지.
