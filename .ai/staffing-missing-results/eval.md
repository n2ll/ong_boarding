# 검증
- RED/GREEN: 새 결과·누락 집계·구버전 저장 보호 회귀의 실패 후 구현. 관련 parser/API/follow-up/AI 메모 포함 76/76 PASS.
- TypeScript: 최종 검사 PASS. 독립 diff 리뷰 P1/P2 없음.
- 합성 CUA: 실제 StaffingFollowUpQueue + StaffingPreparationPanel 연결. 같은 공고의 수동 연락/3개 미기록을 한 행 표시; 선탑 참여+백업 미참여 저장 후 정확한 두 날짜만 해소; 다른 날짜·공고·연락 기한 보존 PASS.
- 결과 모두 기록 후 오늘 0건, 전체 1건(원래 미래 연락) 유지 PASS. 미참여는 실제 records에 들어가지 않고 계획/선탑 상태 유지.
- 390px: 가로 넘침 없음. 동시 수정 409 시 초안 유지·저장 중단·최신 기록 반영 후 재저장 PASS.
- 임시 검수 페이지 제거, 검수 fetch는 메모리 fixture만 사용. 실제 지원자 문자/AI 호출/DB 쓰기 없음.
- 프로덕션 빌드: `npm run build` exit 0 (타입·린트 포함).
- 배포: PR 체크·머지 후 운영 홈 읽기 전용 확인 예정. 배포 결과는 PR에 기록한다.
