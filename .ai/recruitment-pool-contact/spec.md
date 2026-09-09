# Spec
- 새 `recruitment_contact_authorized` pool event는 관리자의 기존 채용풀 연락 확인이다. 개인의 marketing_consent/marketing_consent_at은 변경하지 않는다.
- service role로 사전에 기록한 근거만 인정: batch UUID, 지원자, 현재 정규화 번호, new_job 목적, 1~3개 공고, 본문 fingerprint, 관리자 설명, 최대 24시간 유효기간 일치.
- legacy 원본·출처 확인 및 후속 거절 이력 검증 후 해당 1회 발송의 consent_required만 해소한다. 일반 캠페인이나 자유 문자에는 적용하지 않는다.
- 실제 수신거부/번호 검증/블랙리스트/노출/기존 후보/제외 상태/발송 빈도/outbox 멱등성은 유지. 근거·상태 조회 실패 시 발송하지 않는다.
- 파일럿 상한 50명; 공고 1~3개·최대 24시간·새 인입만·개별 paused 보호·전역 OFF 정책 유지.
- 실패/롤백: 발송 불명은 재전송하지 않고 기존 outbox로 확인. 자동 응대 중단은 OFF. 근거는 만료시키고 기록은 보존. 이미 발송한 문자는 취소할 수 없다.
