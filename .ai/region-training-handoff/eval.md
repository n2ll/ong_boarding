# 검수 기록 — 2026-09-10

- 지역·복수 상담·관찰 저장·라우터·선탑 준비/진행·추천 API 집중 회귀 266/266 통과. 메타 없는 신규 지원자 회귀 추가 후 선탑 helper 11/11 통과(최종 관련 회귀 총 267건). 저장 테스트 타입 보완 후 저장 25/25 및 `tsc --noEmit --incremental false` 오류 0건.
- `npm run build` 통과(기존 테스트 파일의 module 변수 lint 경고 2건). 선탑 이력이 없는 상태의 optional metadata 접근을 빌드에서 발견해 RED→GREEN 수정.
- PC 1280px / 모바일 390px 연락 fixture 2/2 통과: 실제 공고 귀속 대화, 전화 링크, 원문 확인, 대화 왕복 후 미저장 메모·가능 시간 보존, 명시 저장만 1회.
- 캡처 육안 검토 중 모바일 하단 메뉴의 대화 발송 영역 가림 발견. 연락창을 body 포털로 분리. 입력 후 발송 버튼 trial 클릭 실패를 재현하고 수정 후 PC/390px E2E 2/2 재통과. 실제 발송은 하지 않았으며 최종 빌드도 통과.
- 독립 diff 리뷰에서 같은 수신 문자 내 복수 지역 저장 충돌 및 ‘대구’ 정규화 오류 발견. 각각 실패 재현 후 수정, 저장·추천 API 42/42 통과.
- 지역 순위는 실제 상차/배송 행정구역 일치이며 통근 가능 판단이 아니다. 지원자 최신 수신 시각 우선, 도로명 혼동·거절·타인 발언·없는 원문·수신거부·동의·노출·피로도 제한 회귀 포함.
- Haiku 실호출·운영 DB 쓰기·문자 발송 없음. 기존 중단 문의 재처리, 자동 응대 활성화, 파일럿 연장 없음.

재현: `node --experimental-strip-types --test`로 이번 변경의 region-preference, multi-job-consultation, training-followup, consultation-observations, router-phone-identity, stages/consultation, staffing-preparation-api/suggestions, staffing-preparation, staffing-training-progress, announce-targets-pagination 테스트 파일 실행. 브라우저는 `playwright test --config=playwright.consultation.config.ts training-contact.spec.ts` (localhost 인증 fixture, API 가상 응답, 외부 통신 차단).
