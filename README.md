# 옹보딩 (Ongboarding)

시니어(50~70대) 배달원 등 **긱워커 채용에 특화된 B2B SaaS 채용 관리 플랫폼**.

- **지원자**: 앱 설치·복잡한 폼 없이 **SMS/채팅(옹봇)** 만으로 채용 절차를 끝낸다.
- **매니저**: 스크리닝·면접 조율·서류 안내 등 반복 업무를 **AI 에이전트가 대행**, 어드민 대시보드에서 모니터링·개입한다.

> **포지셔닝(2레이어)**: 시니어 특화는 **진입 wedge·브랜드·운영노하우** 레이어이고, 공급 커버리지·데이터모델은 **긱워커 전반(50대 미만 포함)을 수용**한다. 인력풀 분류·매칭은 나이가 아니라 **능력·가용성**(권역·차종·시간대·즉시투입) 기준으로 설계한다. 자세히는 [`PRODUCT_DIRECTION.md`](./PRODUCT_DIRECTION.md) §5.

## 핵심 도메인 규칙 — "확정 뉘앙스 절대 금지" ⭐

지원자가 정보를 보내거나 에이전트의 질문에 긍정해도, 그것이 곧 **근무 확정/배정을 의미하지 않는다.** 근무 확정은 **매니저가 별도로** 한다. 모든 AI 응대·문구·전이 로직의 최상위 규칙이다.

## 기술 스택

- **Next.js 14 (App Router)** · React 18 · TypeScript(strict)
- **Tailwind CSS v4** · Radix/shadcn (일부 MUI/Emotion) · 폰트 Pretendard
- **Supabase** (Postgres + Database Webhook)
- **Anthropic Claude** (응대 Sonnet / 분류 Haiku)
- 외부 연동: **SOLAPI**(SMS·알림톡) · Slack · 카카오/네이버 지오코딩 · Google Sheets
- 배포: **Vercel** (Cron 포함) · import alias `@/*`

## 디렉토리 지도

| 경로 | 내용 |
|---|---|
| `app/(admin)/` | 어드민 대시보드 (대시보드·파이프라인·공고·추천·실시간응대·두뇌 등) |
| `app/apply/` | 지원자용 공개 지원 폼 |
| `app/api/` | REST 라우트 핸들러 (상세: `app/api/README.md`) |
| `app/api/webhooks/` | 인입 SMS 메인 진입점 (상세: `app/api/webhooks/README.md`) |
| `components/` | 화면 단위 컴포넌트 + `ui/`(shadcn) |
| `lib/` | 외부 서비스 어댑터·도메인 헬퍼 (상세: `lib/README.md`) |
| `lib/agent/` | 단계별 Claude 응대 엔진 (상세: `lib/agent/README.md`) |
| `docs/migrations/` | 날짜 프리픽스 SQL 마이그레이션 |

## 실행

```bash
npm i          # 의존성 설치
npm run dev    # 개발 서버
npm run build  # 프로덕션 빌드
npm run lint   # 린트
```

환경변수는 `.env.local`에만 둔다(gitignore 대상). 키 목록·용도는 [`docs/기능설명서.md`](./docs/기능설명서.md) §9 참고.

## 문서

- 제품 방향·로드맵: [`PRODUCT_DIRECTION.md`](./PRODUCT_DIRECTION.md)
- 전체 기능·도메인·환경변수: [`docs/기능설명서.md`](./docs/기능설명서.md)
- AI 작업 가이드: [`AGENTS.md`](./AGENTS.md)
- 영역별 상세: `lib/README.md` · `lib/agent/README.md` · `app/api/README.md` · `app/api/webhooks/README.md`
