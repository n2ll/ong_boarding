# Evaluation
- `node --experimental-strip-types --test lib/pool-preferences.test.ts lib/admin/pipeline-signal-batches.test.ts lib/admin/pipeline-recommendation.test.ts`: 33/33 통과. 최신 시각·ID 우선, 손상된 최신 기록의 과거 폴백 금지, 미등록 및 둘 다 분류, 원문 AND 검색, 기존 추천 회귀 포함.
- `npx playwright test --config=playwright.pilot.config.ts pool-preference-matching.spec.ts`: 1/1 통과. 가상 후보 4명으로 필터·저장/복원·선택 해제·조회 실패 차단/재시도·390px 모바일 검수. 외부 요청 차단, 운영 DB/문자 쓰기 없음.
- `npx tsc --noEmit`, `npm run build`, `git diff --check`: 통과. 기존 job-audience-preview.test.ts의 no-assign-module-variable 경고 2건만 잔존.
- 브라우저 검수 초기 실패는 가상 상태값·선택상자 locator·외부 폰트 차단 fixture를 수정하여 해소. 데스크톱/모바일 스크린샷 직접 확인.
- 선택된 희망 조건은 기존 추천의 입력 집합을 좁힌다. 규칙 점수·차량 확인·문자 동의·근무 확정에는 영향을 주지 않는다.
- 배포 후 운영 화면과 자동 응대 OFF 상태를 별도로 확인한다.
