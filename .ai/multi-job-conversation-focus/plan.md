# multi-job conversation focus plan
- [x] 명시적 conversation_focus_job_id 라우팅과 reply claim 구현 — root, route/runtime tests
- [x] 멱등 관심·초점 전환과 선택 세대·예약 보호 RPC 구현 — focus_db, 실제 폐기 Postgres 검증
- [x] 연속 문자 병합·잠금 대기 복구·불명확 발송 잠금 보존 — root/focus_ui, 실제 모듈 런타임 테스트
- [x] 개인 공고함 관심만 저장/대화 전환·재시도 UI 구현 — focus_ui, 클라이언트 계약 테스트
- [x] 전체 build와 확정 문구·diff 검토 — npm run build, git diff --check
- [x] 배포용 빌드에서 모바일/데스크톱 E2E 검증 — focus_ui/root, 18건 통과
- [x] eval.md 최종 근거 및 검토용 PR 설명 준비

다음 인계: 커밋·푸시·검토용 PR 생성. 운영 적용은 아래 순서로 별도 진행한다.

운영 적용은 별도 단계: AI off 확인 → 새 migration 적용 → PR 머지/배포 → 통제된 법인폰 실문자 검증 → 파일럿.
