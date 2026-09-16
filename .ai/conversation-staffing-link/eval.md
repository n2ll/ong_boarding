# 검증
- `staffing-record-entry.test.ts`: 구현 전 2건 실패 확인 후 3건 통과. 선택 공고·지원자·목적 보존, 잘못된 링크, 첫 기록/손상/기존 후속 기록 경계를 확인했다.
- 새 테스트 + `staffing-preparation-api.test.ts` + `admin-unsaved-navigation.test.ts`: 45/45 통과.
- 변경 파일 ESLint, `npx tsc --noEmit`, `npm run build`, `git diff --check` 통과. 빌드의 기존 테스트 파일 `no-assign-module-variable` 경고 3건은 변경 범위 밖이다.
- 로컬 가상 후보(두 공고)로 선택 공고의 선탑 일정 편집창 진입, 최초 빈 기록, 같은 `/jobs` 안에서 미저장 변경 확인 후 참여·결과 편집창 진입을 확인했다.
- 독립 검토에서 같은 페이지 이동 후 기존 상세 초안이 남는 문제를 찾아, 링크 처리 시 상세를 닫도록 수정했다. 브라우저 재확인과 수정 재검토에서 차단 사항 없음.
- 검수용 API는 모두 가상 응답이며 쓰기 요청을 차단했다. 임시 검수 페이지·서버·탭은 제거했다. 실제 저장·발송·AI 호출·운영 데이터 변경 없음.
