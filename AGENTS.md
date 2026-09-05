# AGENTS.md — 옹보딩(Ongboarding)

이 저장소에서 AI 에이전트가 작업할 때의 핵심 가이드. 상세 규칙은 `.cursor/rules/`에, 도메인/기능 설명은 `docs/기능설명서.md`에 있다.

## 제품
시니어(50~70대) 긱워커 채용에 특화된 B2B SaaS 채용 관리 플랫폼.
- **포지셔닝 2레이어**: 시니어 특화 = 진입 wedge·브랜드. 공급/데이터 = 긱워커 전반(50대 미만 포함) 수용. 인력풀 분류·매칭은 나이가 아니라 능력·가용성 기준. 나이 하드코딩 분기 금지.
- 지원자: 앱·폼 없이 **SMS/채팅(옹봇)** 으로 채용 완료.
- 매니저: 반복 업무를 **AI 에이전트가 대행**, 어드민 대시보드로 관리.

## 스택
Next.js 14 (App Router) · React 18 · TypeScript(strict) · Tailwind v4 · Radix/shadcn(+일부 MUI) · Supabase · Anthropic Claude · SOLAPI/Slack/지오코딩. 배포 Vercel. alias `@/*`.

## 작업 4원칙 (카파시 기반)
1. **생각 먼저** — 추측 금지, 모호하면 질문, 트레이드오프 제시.
2. **단순함 우선** — 요청한 최소 코드만. 투기적 추상화·옵션 금지.
3. **외과적 변경** — 필요한 줄만. 무관한 리팩터링/포맷 변경 금지. 기존 스타일 준수.
4. **목표 기반 실행** — 검증 가능한 성공 기준 설정 후 반복. (이 repo는 테스트가 없으니 보통 `npm run build`+타입+영향 경로 수동 확인)

## AI-Native SDLC
기능·버그·마이그레이션·에이전트 동작 변경처럼 구현으로 이어지는 비단순 작업은 `docs/ongboarding-ai-native-sdlc/SKILL.md`를 따른다. 작업 크기에 따라 산출물 깊이를 조절하고, 작은 수정에는 불필요한 `intent/spec/plan` 파일을 만들지 않는다.

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
- 훅: `useState`/`useEffect` 등은 **컴포넌트 맨 위, 모든 조기 return보다 앞**에서 선언한다(쓰는 곳 옆이 아니라). `npm run build`가 `react-hooks/rules-of-hooks`로 막는다 — 이 규칙은 스타일이 아니라 화면이 죽는 것을 막는 것(React #310). `.eslintrc.cjs`에 취향 규칙을 추가하지 말 것.
- 시크릿은 `.env.local`에만. 문서/코드/커밋에 실제 값 금지.
- 배포 리전: 서버리스 함수는 **서울(`icn1`)** — `vercel.json`의 `regions`. Supabase가 ap-northeast-2인데 기본값 `iad1`(워싱턴)이면 쿼리마다 태평양을 왕복해 화면 하나가 1~2초씩 걸린다(실측: 지원자 목록 1994ms vs 로컬 389ms). 되돌리면 그 지연이 그대로 돌아온다.
- `vercel.json`은 스키마가 `additionalProperties: false`다 — **주석용 `"//키"`를 넣으면 배포가 실패한다**(실제로 겪었다). 근거는 커밋 메시지나 이 파일에 남길 것. 스키마: `https://openapi.vercel.sh/vercel.json`
- API 페이로드는 **전송량(gzip)으로 재라.** `JSON.stringify(...).length`나 응답 문자열 길이로 재면 이 제품에선 약 7배 부풀려진다(지원자 목록 원본 689KB = 실제 전송 95KB). 브라우저에서 `performance.getEntriesByType("resource")`의 `encodedBodySize`를 보거나 응답을 파일로 받아 `gzip -9`로 재라. 따라오는 결론도 바뀐다 — 같은 값이 수백 번 반복되는 컬럼은 gzip이 거의 0으로 만들고 **자유텍스트만 그대로 남는다.** 컬럼 다이어트의 값어치는 컬럼 수가 아니라 값의 다양성으로 판단할 것.
- `next dev`와 `next build`/`next start`는 `.next`를 공유한다. dev가 떠 있는 채로 빌드하면 `Cannot find module for page: /_document` 같은 **엉뚱한 오류**가 나고 `.next`가 반쯤 망가진다. 빌드 전에 `ps aux | grep "[n]ext"`로 확인할 것. 그리고 `npm run build | head -3`처럼 파이프를 조기 종료시키면 SIGPIPE로 빌드가 중간에 죽는다(로그는 파일로 받을 것).
