# 구현 계획
- [x] 지역 상담 응답·원문 검증 — region_consultation, 집중 회귀.
- [x] 지역 선호 영속 기록·다음 공고 연락 우선순위·원장 표시 — root, 저장/추천 API 회귀.
- [x] 선탑 후속 질문·관리자 연락 동선 — training_intent_agent, 행동 회귀 및 PC/모바일.
- [x] 통합 검수·독립 diff 검토·빌드 — root.

배포는 관련 PR의 Preview 검사 후 squash merge하며 Production 성공 상태를 최종 응답에서 확인한다. 운영 대상 재처리·발송·활성화는 이 배포에 포함하지 않는다.
