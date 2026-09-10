# 검수 — 2026-09-10
- 결정론: preparation 모델/API, date-board 집계/API, 기존 참여·선탑 모델 41건 PASS.
- 명령: `node --experimental-strip-types --test lib/admin/staffing-preparation.test.ts lib/admin/staffing-preparation-api.test.ts lib/admin/staffing-date-board.test.ts lib/admin/staffing-date-board-api.test.ts lib/admin/staffing-participation.test.ts lib/admin/staffing-training.test.ts`.
- `npx tsc --noEmit`, `git diff --check` PASS.
- 브라우저: `npx playwright test --config playwright.consultation.config.ts e2e/staffing-date-board.spec.ts` — production build 후 1280/390px 2건 PASS.
- 확인: 확정·예비 분리, 날짜 셀→배차 준비→명시 확인→저장→충원 갱신. 목표 미정, 같은 날 다른 라인 확정 경고, 503 시 지난 수치 숨김. 가로 넘침·예상 밖 쓰기·페이지 오류 없음.
- RED: 기존 빌드에는 충원판 버튼 없음. 첫 GREEN 시 검수 fixture의 primary 계약·문구를 보정했고, Next.js의 별도 alert를 제외하도록 실패 안내 검증을 충원 영역에 한정했다.
- 교차 리뷰에서 발견한 마감 공고/중단 후보 신규 확정 허용을 보완했다. 해당 서버 경계 2개 RED→GREEN, UI 안내·비활성 반영.
- 기존 확인 기록을 구버전 화면이 제거하는 저장은 409. 실제 참여 이력·CAS·멱등성 유지.
- 스크린샷: `/tmp/ong-staffing-date-board-1280.png`, `/tmp/ong-staffing-date-board-390.png`.
- 실제 DB·SMS·AI 운영 설정 변경 없음. 배포 후 실제 공고 조회만 확인했다.
- PR #151 스쿼시 머지: `b22bf211f57f935a819a7c72191aba051f0e7f5b`.
- 자동 운영 배포가 생성되지 않아 같은 main 커밋으로 Vercel UI에서 Production 배포 실행. `CVkn7Vq1JeodunvstQcCteiRA1GC` Ready, 운영 도메인 할당 확인(2026-09-10 15:28 KST).
- 15:30 KST 운영 `/jobs`에서 충원판을 열어 실제 3개 일반 배송 공고·기본 비교 기간 9/21~9/23·각 셀 목표 1/확정 0/예비 0을 확인했다. 실제 확정 저장은 실행하지 않았다.
- 운영 화면의 선택 50명·공고 3개·9/24 13:53:27 종료·개별 중지 유지 배너도 동일했다.
# 한계와 다음 작업
- 일자별 실제 필요 인원/운행일 입력은 아직 없다. 공고 capacity를 각 비교일의 모집목표로 표시하며 실제 운행을 단정하지 않는다.
- 충돌 경고는 동일 날짜 기준. 정확한 시간 중복은 상차·수거·반납 시간을 관리자가 확인해야 한다.
- 선탑 후속 연락·담당자·다음 행동을 같은 화면에 묶는 개선은 다음 순서로 남는다.
