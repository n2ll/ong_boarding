# Evaluation
- Pilot cap RED→GREEN: 50명 허용, 51명 거절, paused·opt-out·전역 OFF 유지.
- 연락 근거 RED→GREEN: false/null import 승인, scope·본문·번호 불일치, 근거/거절 조회 실패, 처리 중 거절·opt-out·근거 만료/삭제 차단.
- `node --experimental-strip-types --test lib/recruitment-contact-authorization.test.ts lib/sms-consent-policy.test.ts lib/admin/new-job-send-guard.test.ts lib/agent/kill-switch.test.ts lib/agent/response-containment.test.ts`: 122/122 통과.
- `tsc --noEmit --incremental false`, 변경 파일 ESLint, `git diff --check`: 통과.
- `npm run build`: 통과. 기존 무관한 job-audience-preview.test.ts module 변수 경고 2건 유지.
- 독립 검토에서 발견한 순차 발송 중 상태 변경 문제는 공급자 호출 직전 근거·동일 번호·거절 이력 재조회로 보강.
- 운영 공고 지정 노출 적용 완료. 배포·실제 발송·파일럿 세션 결과는 운영 후 별도 기록. 개인정보·번호·문자 원문·접근 키는 저장소에 넣지 않음.
