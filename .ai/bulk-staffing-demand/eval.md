# 검증 결과
- `node --experimental-strip-types --test lib/admin/staffing-demand-batch.test.ts lib/admin/staffing-demand-api.test.ts`: PASS 19/19 (신규 5 + 기존 API 14).
- 신규 정책·재시도 테스트 RED → GREEN, 손상 기록 경고 회귀 RED → GREEN.
- `npx tsc --noEmit`: PASS. `npm run build`: PASS, 변경 외 기존 테스트 파일의 no-assign-module-variable 경고 3건만 존재.
- 변경 TS/TSX ESLint, `git diff --check`: PASS.
- 독립 검토: 손상 수요 경고 누락 보완 후 차단 문제 없음.
- 로컬 가상 데이터 + 실제 충원판/모달, 390×844: PASS, 문서·모달 폭 390px, 고정 저장 버튼과 입력 영역 확인.
- 3라인×3일 중 기존 2건 유지, 신규 7건 시도 → 성공 5·동시 수정 1·응답 손실 1. 미확인 1건 재시도 후 성공 6·동시 수정 1, 가상 저장 수 6으로 중복 없음.
- 선택한 라인·하루만 운행 없음 저장 후 충원판 필요 0명 표시: PASS.
- 검수용 route 제거·dev 종료 후 최종 빌드. 실제 DB·지원자·발송 데이터 변경 없음.
remaining_risk:
  - 일괄 저장은 개별 요청들의 처리이며 전체 원자적 트랜잭션이 아니다. 부분 결과를 명시하고 동일 요청 재시도를 제공한다.
  - 운영 환경의 실제 수요 저장은 수행하지 않음. 기존 인증·DB 동시성 경로를 재사용한다.
