# 검수 — 2026-09-10
- 신규 모델/API 테스트 6개 RED 확인 후 직접 관련 42개 PASS. `/tmp/staffing-follow-up-green.log`.
- `npm run build`를 포함한 격리 E2E 서버 기동 성공. 기존 대화·전화 복귀와 작성 중 메모 보존 PC1280/모바일390 2개 PASS. `/tmp/ong-staffing-follow-up-e2e.log`.
- 신규 E2E PC: 연락·담당자·다음 행동·예정일 저장, 담당자·미완료/기한/완료 필터, 할 일 완료에도 기존 미확정 날짜/선탑/실적 보존 PASS. `/tmp/ong-staffing-follow-up-e2e-final.log`.
- 신규 E2E 모바일390: 연락만 저장, 실패 후 초안 유지, 같은 키 재시도, 비교 날짜 자동추가 없음, 가로 넘침 없음 PASS. `/tmp/ong-staffing-follow-up-mobile-final.log`.
- 최초 E2E의 정확한 label 선택자가 select 옵션/textarea 값까지 포함해 실패했다. 접근성 트리의 정상 combobox/textbox 이름을 확인해 테스트 선택자만 수정했다. 앱 우회·검증 완화 없음. 이미 통과한 경로는 반복하지 않고 기존 빌드를 재사용했다.
- 타입 검사와 diff 공백 검사 통과. 모델/API와 UI 교차 리뷰에서 P1/P2 발견 없음.
- `/tmp/ong-staffing-follow-up-1280.png`, `/tmp/ong-staffing-follow-up-390.png` 확인. 모바일 고정 저장 버튼 및 입력 유지 확인.
- 실제 SMS·운영 DB·AI 설정 변경 없음. DB 마이그레이션 불필요.
# 한계와 다음
- 담당자는 공용 계정 환경의 수기 표시명. 할 일 자동 알림이나 AI의 연락 기록 해석은 포함하지 않는다.
- 다음 필수: 일자별 실제 운행 여부·필요 인원 → 반복 질문과 불필요한 수동 검토를 줄이는 AI 응대 연결.
