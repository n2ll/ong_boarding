-- 공고에 단가·정책 필드 추가 (P2 — 인계 자체 감소)
--
-- 인계 큐에서 가장 큰 비중을 차지하는 '단가·정산'(단가 문의)과 '계약·고용/기타 정책' 인계는
-- 공고에 해당 정보가 없어 에이전트가 답하지 못하고 매니저로 넘긴 케이스다.
-- 공고에 이 값이 채워져 있으면 에이전트가 [현재 공고] 컨텍스트로 직접 안내(정보 제공)하여 인계가 줄어든다.
-- ⚠️ 어디까지나 '정보 제공'이며, 근무 확정/배정 뉘앙스는 절대 만들지 않는다.

alter table public.jobs
  add column if not exists pay_info text,
  add column if not exists policy_notes text;

comment on column public.jobs.pay_info is '급여·정산 정보(에이전트가 단가 질문에 직접 답할 근거). 예: 건당 3,000원·주1회 정산';
comment on column public.jobs.policy_notes is '고용형태·보험 등 정책 안내(에이전트 응대 근거). 예: 프리랜서 계약, 4대보험 미적용';
