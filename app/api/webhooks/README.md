# `app/api/webhooks/` — 외부 시스템 webhook 진입점

## `supabase-new-message/route.ts`

**SMS Gateway 인입 SMS의 메인 진입점.** Supabase Database Webhook이 트리거함.

### 왜 이 경로인가 (배경)

옛 흐름은 `SMS Gateway → POST /api/messages/inbound`였는데, 현재 SMS Gateway 안드로이드 앱은 **Supabase REST API에 직접 INSERT**하도록 변경됨. 그래서 우리 서버의 inbound 라우트가 호출되지 않음.

→ Supabase Studio에서 Database Webhook을 등록해, messages INSERT 이벤트가 발생하면 이 라우트로 webhook을 쏘게 함.

### 흐름

```
지원자 SMS → 법인폰 → SMS Gateway 앱
  └─ Supabase REST POST /rest/v1/messages   (direction='inbound')
     │
     └─ Supabase Database Webhook
        └─ POST /api/webhooks/supabase-new-message
           │
           ├─ payload 검증 (Authorization: Bearer SUPABASE_WEBHOOK_SECRET)
           ├─ msg.direction='inbound' AND classification IS NULL 가드 (멱등성)
           ├─ phone으로 applicants 매칭
           │   ├─ 매칭됨 → message에 applicant_id 채우고 router.runAgentForCandidate
           │   └─ 매칭 안 됨:
           │       ├─ isHardSpam([광고]/URL/비휴대폰) → classification='other'
           │       ├─ Haiku triage → is_baemin AND conf ≥ 0.7
           │       │   ├─ applicants INSERT (status='스크리닝 전', source='baemin')
           │       │   ├─ apply 폼 URL SMS 발송 (`baemin_apply_invite`)
           │       │   └─ classification='baemin'
           │       └─ 그 외 → classification='pending' (매니저 인박스로)
           │
           └─ triage 사용량 → ai_usage_daily + inbound 메시지 행에 토큰 컬럼
```

### 인증

```
Authorization: Bearer <SUPABASE_WEBHOOK_SECRET 값>
```

`SUPABASE_WEBHOOK_SECRET` 환경변수 미설정 시 500 에러로 응답. (보안상 안전 — 잘못된 요청 거부)

### Supabase Studio 등록 방법

1. Database → Webhooks → "Create a new hook"
2. Table: `messages`
3. Events: INSERT
4. HTTP method: POST
5. URL: `https://<프로덕션 도메인>/api/webhooks/supabase-new-message`
6. HTTP Headers: `Authorization: Bearer <값>`

### 멱등성

같은 메시지에 webhook이 두 번 와도(재시도) `classification IS NOT NULL`이면 즉시 종료. 매니저가 인박스에서 분류한 직후 또 들어오는 케이스 방지.

### 사용 예산

- `maxDuration: 90s` — router는 1분 응답 텀 + Claude + SOLAPI로 60초 가까이 걸림. 충분히 잡아둠.
- `force-dynamic` — 캐시 X.

### 디버깅

| 증상 | 확인 포인트 |
|---|---|
| webhook 도착 확인 | Vercel Logs에서 `/api/webhooks/supabase-new-message` 검색 |
| 인증 실패 (401) | Supabase Webhook 설정의 Authorization 헤더 값과 `SUPABASE_WEBHOOK_SECRET` 일치 확인 |
| messages 안 쌓임 | SMS Gateway 앱(`C:\sms-gateway`) heartbeat 확인 — `/api/admin/heartbeat` |
| triage 호출 안 됨 | 매칭된 applicant가 있어서 매칭 분기를 탔을 가능성 (phone 정규화 확인) |
| triage 결과 확인 | `messages.classification` 컬럼 / Vercel Logs의 `[supabase-webhook]` |
