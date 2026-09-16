# 검증
- 정책 TDD: 새 7개 RED 후 통과. `node --experimental-strip-types --test lib/admin/staffing-replacement-comparison.test.ts lib/admin/staffing-date-recommendation.test.ts` 총 16/16 통과.
- `npx tsc --noEmit --incremental false` 통과. 독립 diff 검토에서 P1/P2 발견 없음.
- 실제 StaffingPreparationPanel에 합성 GET 응답만 연결한 임시 화면으로 Chrome 검수. 확정자만 선택, 다른 확정자·거절 제외, 미확인/손상/타 라인 기록 구분, 3명씩 더 보기, 연락 상세, 기록창 연결·복귀, Tab 순환 및 Escape 확인.
- PC 3열과 390px 세로 배치 확인. 문서/비교창 가로 넘침 없음. 재조회 후 삭제된 확정자 선택 초기화 및 날짜 변경 후 확정자 없음 안내 확인.
- 날짜 자동화 fill은 입력값만 바꿔 React 상태가 갱신되지 않았으나 실제 ArrowUp 키 입력은 정상 반영. 제품 수정 불필요.
- 검수 쓰기 요청 0건. 문자·AI 호출·운영 DB 변경 없음. 임시 검수 라우트는 빌드 전 제거.
- `npm run build` 종료 코드 0. dev 종료 및 임시 검수 라우트 제거 후 실행. 배포 결과는 PR에 첨부.
