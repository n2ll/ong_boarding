# 관리자 상태 표시 evaluation
- 회귀 재현: 모드 범위 1건, 최근 답장 2건, 자동화 요약 1건 red → green.
- 단위 테스트: PASS 67/67 — agent-mode-view/wiring, automation-view, live-console-presentation, pipeline-signal-batches/row, brain-overview.
- 최근 답장 API: 캠페인 외 inbound, outbound 제외, 이벤트 없는 지원자, 요청 범위 제한, 1,001번째 메시지, 중간 페이지 오류 확인. 기존 5,001번째 이벤트 조회도 유지.
- 빌드 및 변경 경로 ESLint: PASS. 기존 workspace root 경고와 job-audience-preview.test.ts의 module 변수 경고 2건은 미변경.
- 브라우저: `npx playwright test --config=playwright.consultation.config.ts` PASS 8/8. 로컬 인증·API fixture, 외부 요청 차단. 신규 상태 표시 6건과 기존 모바일/데스크톱 공고별 상담 표시 2건.
- 초기 dev 기반 검수 실패: trace가 Next DevServer의 getNextFontManifest → loadManifest JSON 파싱 경합을 지목했다. 운영 코드 우회 없이 검수 서버를 build → start로 변경하고 전체 8건 통과.
- 화면 확인: /tmp/admin-status-conversation-mobile.png, /tmp/admin-status-stop-dialog.png. 운영 DB 변경·문자 발송·모드 전환 없음. 중단 버튼은 로컬 API fixture에서만 실행.
- 운영 반영 전 PR 검토 필요. 법인폰 보류 건과 미확인 좁은 화면 발송 버튼 현상은 이번 범위 밖.
