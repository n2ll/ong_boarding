# Tally 웹훅 연결 가이드 (팀원용)

> 목적: 홈페이지 지원 폼(Tally) 제출이 **실시간으로** 옹보딩 DB에 들어오고 AI 첫 응대가 나가게 한다.
> 현재 상태: 서버 쪽(Vercel 환경변수 `TALLY_SIGNING_SECRET`)은 설정 완료. **Tally 대시보드에서 웹훅 연결만 하면 끝.**

## 연결 절차 (5분)

1. [tally.so](https://tally.so) 로그인 → 지원 폼 선택
2. 상단 **Integrations** 탭 → **Webhooks** → **Connect**
3. **Endpoint URL** 입력:
   ```
   https://ong-boarding-pi.vercel.app/api/webhooks/tally
   ```
4. **Signing secret** 설정 — 중요:
   - Tally가 시크릿을 자동 생성해 보여주는 경우 → 그 값을 복사해서 관리자(용식)에게 전달 (Vercel 환경변수를 그 값으로 맞춰야 함)
   - 직접 입력하는 경우 → 관리자에게 현재 `TALLY_SIGNING_SECRET` 값을 받아 동일하게 입력
   - ⚠️ 시크릿 값을 카톡·문서 등에 남기지 말 것 (전달은 1회성 비밀 채널로)
5. 저장 후 **테스트 제출** 1건 진행

## 연결 확인 방법

- 성공: 제출 직후 옹보딩 파이프라인에 지원자가 생기고, AI 시작 문자가 발송됨 + Slack 알림
- 실패(시크릿 불일치): 웹훅이 401로 거절됨 — Tally 대시보드의 웹훅 로그에서 응답 코드 확인 가능
- 파싱 실패 등 예외 시: 옹보딩이 지원자만 우선 저장하고 Slack에 경고를 보냄 (유실 없음)

## 참고

- 이 웹훅이 연결되기 전까지 Tally 지원자는 기존(Airtable 배치) 경로로만 들어옴 — 383명 방치 사태의 원인이었던 그 경로다. 연결되는 순간부터 신규 지원자는 실시간 처리된다.
- 기술 상세: [app/api/webhooks/README.md](../app/api/webhooks/README.md)
