# 검증 · 2026-09-17

- #173: squash `9850eb3`, Vercel success. 운영 `/jobs`에서 4개 핵심 메뉴와 모집 화면 로딩 확인.
- `staffing-note-draft`, `staffing-note-draft-api`, `staffing-record-entry`: 기존 테스트 25개 통과.
- 변경한 UI 2개 파일 범위 ESLint와 `git diff --check` 통과.
- 가상 데이터 브라우저: 일반 기록 메모 진입, AI 버튼 전 요청 없음, 제안의 기존값·근거·확인 질문, 확인 저장의 payload, 메모·기준일 실패 후 유지, 직접 입력 전환, 메모 단독 저장 전 확인/취소 시 직접 변경 유지, 승인 시 기존 기록 유지, 명시적인 연락 기록 직접 진입 확인.
- 390×844: 가로 넘침 없음, 주요 버튼 44px, 메모·작성자·하단 저장 버튼 확인.
- CUA 날짜 `fill`은 DOM 값만 바뀌어 실제 키 입력으로 변경 후 상태와 요청 payload를 확인했다.
- 임시 fixture/서버/탭 제거. 실제 DB·문자·모델 호출 없음.
- `npm run build` 통과. 기존 테스트 파일의 `module` 변수 ESLint 경고 3건만 유지.
