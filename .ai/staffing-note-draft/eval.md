# 검수 — 2026-09-13

- 최초 브라우저 RED: ‘메모로 기록’ 진입 버튼 부재. 구현 후 PC 1280px·모바일 390px 메모 입력→검토→선택 저장 통과.
- 핵심/서버/기존 운영 기록 회귀: `node --experimental-strip-types --test lib/admin/staffing-note-draft.test.ts lib/admin/staffing-note-draft-api.test.ts lib/admin/staffing-preparation.test.ts lib/admin/staffing-follow-up.test.ts` — 29/29 통과.
- 브라우저: `npx playwright test --config playwright.consultation.config.ts e2e/staffing-note-draft.spec.ts e2e/staffing-simple-entry.spec.ts e2e/staffing-follow-up.spec.ts` — 프로덕션 빌드 성공, 6/6 통과.
- 생성 실패 시 메모 유지, 저장 네트워크 실패 시 동일 action_key 재사용, 확인 전 운영 쓰기 없음, 선택 해제한 기존 할 일 및 배차 확정·상차지·프로·팀 메모 보존을 검증.
- 독립 리뷰에서 직접 입력 전환 시 선택 제안 누락 및 409 후 보관 초안 누락 발견. 수정 전 동일 브라우저에서 3개 assertion 실패를 재현하고, 선택 제안 이관·무효화/최신 기록과 내 제안 별도 보관 수정 후 통과.
- 390px·1280px 스크린샷 검토. 가로 넘침 없이 저장 버튼이 화면 안에 보인다.
- 인증·공고/후보 연결 확인·허용 필드·원문 근거·기존 확정 보존에 대해 독립 코드 리뷰. 추가 P1/P2 미발견.
- 실제 Haiku 합성 검수와 제약은 `live-eval.md`. 실제 지원자 기록 조회/변경·문자 발송은 검수에 사용하지 않았다.
- Haiku 형식 안내 보완 이후 최종 `npm run build` 성공. 생성 응답은 기록 자동 저장 없이 검토를 거친다.

# 범위와 한계
- 관리자가 선택한 구조화 항목만 저장한다. 자유 메모 원문 자체의 자동 보관은 이번 범위에 포함하지 않는다. 기존 팀 메모는 보존한다.
- 초안은 검토 제안이며 의미 판단의 정확도를 보장하지 않는다. 모호한 날짜·대상은 확인 질문으로 남긴다.
- 날짜별 배차·투입 확정·선탑 접선 상세는 직접 입력에서 관리한다.
- 전체 운영 데이터 마이그레이션은 없다. 메모 생성은 사용량 집계만 쓰며, 저장은 기존 충돌/중복 방지 API를 사용한다.
