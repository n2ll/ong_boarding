# plan
- [x] root: 상담 출력 계약·조건 기반 응답·모호함/원문 검증 테스트
- [x] consultation_data: 상담 가능 공고 조회·멱등 관찰 기록·관리자 타임라인 표시
- [x] root/stage agent: 기존 단계 호출에 상담 계약 연결, 라우팅·최근/연속 문자 문맥 연결
- [x] root: 기존 응대 회귀·새 대화 시나리오·타입/빌드·변경 UI 검증
- [x] root: eval 기록·PR129 반영할 변경 내용과 운영 적용 경계 정리

delivery: 기존 draft PR129에 추가 커밋.

## 2026-09-06 운영 적용
- [x] 운영 DB 선행 조건·AI 모드·진행 중 발송 확인
- [x] AI off → 단일 트랜잭션 migration → 컬럼·RPC·권한 검증
- [ ] PR129 squash merge → Vercel 운영 배포 확인 → 운영 관리자 화면 검수
- [ ] 통제된 번호로 실제 Claude/SMS 검수 후 파일럿 재개 (번호 확인 필요)

배포 최종 상태는 PR129의 머지·Vercel 상태 및 운영 검수 기록으로 확인한다.
