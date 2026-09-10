-- 날짜별 운행 여부·필요 인원. 지원자 확정이나 문자 발송과 독립된 관리자 수요 기록이다.
-- 미기록은 unknown이며 jobs.capacity를 실제 수요로 복사하지 않는다.
-- 배포 순서: 이 마이그레이션 → 앱. 앱 롤백 시 테이블과 이력을 보존한다.
begin;

create table if not exists public.job_staffing_demand_events (
  id bigint generated always as identity primary key,
  job_id bigint not null references public.jobs (id) on delete cascade,
  work_date date not null check (work_date between date '0001-01-01' and date '9999-12-31'),
  state text not null,
  required_count integer,
  base_event_id bigint,
  request_key uuid not null unique,
  actor jsonb not null,
  created_at timestamptz not null default now(),
  constraint job_staffing_demand_state_count_check check (
    case state
      when 'unknown' then required_count is null
      when 'off' then required_count is not null and required_count = 0
      when 'operating' then required_count is not null and required_count between 1 and 999
      else false
    end
  ),
  constraint job_staffing_demand_actor_check check (
    jsonb_typeof(actor) = 'object'
    and actor ?& array['account_id', 'name']
    and jsonb_typeof(actor -> 'account_id') = 'string'
    and length(btrim(actor ->> 'account_id')) > 0
    and jsonb_typeof(actor -> 'name') = 'string'
    and length(btrim(actor ->> 'name')) between 1 and 80
  ),
  constraint job_staffing_demand_base_before_check check (base_event_id is null or (base_event_id > 0 and base_event_id < id)),
  constraint job_staffing_demand_event_scope_unique unique (id, job_id, work_date),
  constraint job_staffing_demand_base_scope_fk foreign key (base_event_id, job_id, work_date)
    references public.job_staffing_demand_events (id, job_id, work_date)
);

-- Exactly one successor per base, including the initial null base. Different dates stay independent.
create unique index if not exists job_staffing_demand_one_successor_uidx
  on public.job_staffing_demand_events (job_id, work_date, coalesce(base_event_id, 0));
create index if not exists job_staffing_demand_latest_idx
  on public.job_staffing_demand_events (job_id, work_date, id desc);

alter table public.job_staffing_demand_events enable row level security;
-- No RLS policies: browser roles have no access. The server may append/read, never rewrite history.
revoke all on table public.job_staffing_demand_events from public, anon, authenticated, service_role;
grant select, insert on table public.job_staffing_demand_events to service_role;
revoke all on sequence public.job_staffing_demand_events_id_seq from public, anon, authenticated;
grant usage, select on sequence public.job_staffing_demand_events_id_seq to service_role;

comment on table public.job_staffing_demand_events is
  '관리자가 입력한 공고·날짜별 수요 이력. unknown/null, off/0, operating/1~999. 후보 확정과 독립.';
comment on column public.job_staffing_demand_events.base_event_id is
  '화면에서 읽은 직전 기록 ID. 같은 공고·날짜·기준의 후속 INSERT는 하나만 허용한다.';
comment on column public.job_staffing_demand_events.request_key is
  '저장 의도별 UUID. 재시도는 기존 작성자·대상·내용과 비교해 같은 결과 또는 409를 반환한다.';

commit;
