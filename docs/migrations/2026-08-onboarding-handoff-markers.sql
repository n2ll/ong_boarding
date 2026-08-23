-- 온보딩 Slack 인계의 실제 발송/의도적 억제를 agent_state JSONB와 분리해 기록한다.
-- 전용 컬럼만 갱신하므로 동시에 도착한 지원자 응답이 checklist/meta를 바꿔도 덮어쓰지 않는다.

alter table public.job_candidates
  add column if not exists manager_handoff_alerted_at timestamptz,
  add column if not exists manager_handoff_slack_suppressed_at timestamptz;

comment on column public.job_candidates.manager_handoff_alerted_at is
  '온보딩 매니저 인계 Slack이 2xx로 수락된 시각';

comment on column public.job_candidates.manager_handoff_slack_suppressed_at is
  '전역 OFF 또는 연습 지원자로 Slack 인계를 의도적으로 생략한 시각(재활성화 후 재발송하지 않음)';
