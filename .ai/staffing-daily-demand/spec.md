# 계약
- 일반 모집 중 배송 공고의 날짜별 수요만 수정한다. 기존 비마트/시스템/검수 제외 정책 유지.
- 상태: unknown(수요 미정, count null), off(운행 없음, count 0), operating(운행, count 정수 1~999).
- 미입력은 unknown. 공고 capacity는 입력 시 참고값으로만 사용한다. 미정 shortage null, off shortage 0. 확정 후보 수는 모든 상태에서 그대로 보여준다.
- off인데 확정 인원이 있거나 필요 인원을 초과하면 재확인 경고. 기록을 자동으로 취소하지 않는다.
- 새 job_staffing_demand_events 테이블: job_id/work_date/state/required_count/base_event_id/request_key/actor/created_at. append-only, RLS로 서버만 접근, 날짜별 base 후속 unique와 request unique로 CAS·멱등 보장. 기존 pool_events는 applicant_id 필수이므로 재사용하지 않는다.
- POST /api/admin/jobs/[id]/staffing-demand: date/state/required_count/base_event_id/action_key/actor_name. 검증 계정으로 작성자 기록. 동일 요청 재시도는 같은 결과, 다른 내용 동일 키/동료 선행 수정 409, 읽기·쓰기 실패 503.
- GET 충원판에 날짜별 demand_event_id/state/invalid_demand 추가. 기간 안의 전체 수요 이력 조회 후 최신 id를 사용한다. 손상된 최신은 미정+경고, 과거 값으로 대체하지 않는다.
- UI: 각 날짜 카드의 수요 입력/수정 → 작은 모달. 일자 고정, 운행 여부·필요 인원·작성자, 고정 저장 버튼. 충돌 시 내 입력 유지하고 최신 수요 확인 후 다시 편집. 저장 실패 시 입력/요청키 보존.
- 마이그레이션 선행, 앱 배포 후 읽기 검수. DB 검수는 별도 로컬 DB에서 가상 데이터만 사용.
# 실패·롤백
- 새 테이블 조회 실패 시 지난 집계/임의 기본 수치를 보여주지 않는다.
- 앱 롤백 시 새 수요 이력은 보존하고 기존 충원판은 공고 모집인원 참고치로만 사용한다. 스키마 삭제 불필요.
