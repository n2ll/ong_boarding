-- P1: 관심 저장 직후 런타임이 종료돼도 주간 자동응대/야간 예약 의도를 잃지 않는다.
-- 선행 적용 순서:
--   2026-08-pool-actions-atomic.sql
--   2026-08-pool-engage-claim.sql
--   2026-08-pool-engage-recovery.sql
--   2026-08-pool-engage-runtime-lock-order.sql
--   2026-08-pool-engage-runtime-message-namespace.sql
--   이 파일
--
-- 관심 이벤트와 이 원장은 record_pool_interest_with_engage_intent 한 트랜잭션에서 저장된다.
-- auto_queue는 같은 트랜잭션에서 engage_queued_at까지 설정하고, auto_now는 동일 action replay가
-- 이 원장을 읽어 기존 outbox를 먼저 복구한 뒤에만 SMS claim을 시작한다.

create table if not exists public.pool_interest_engage_intents (
  action_key uuid primary key,
  applicant_id bigint not null references public.applicants(id) on delete cascade,
  job_id bigint not null references public.jobs(id) on delete cascade,
  intent text not null check (intent in ('off', 'draft', 'auto_now', 'auto_queue')),
  queue_created boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'completed')),
  outcome text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    (status = 'pending' and outcome is null and completed_at is null)
    or (status = 'completed' and outcome is not null and completed_at is not null)
  )
);

create index if not exists pool_interest_engage_intents_pending_idx
  on public.pool_interest_engage_intents (created_at)
  where status = 'pending';

alter table public.pool_interest_engage_intents enable row level security;
revoke all on table public.pool_interest_engage_intents from public, anon, authenticated;
grant select, insert, update on table public.pool_interest_engage_intents to service_role;

create or replace function public.record_pool_interest_with_engage_intent(
  p_job_id bigint,
  p_applicant_id bigint,
  p_immediate boolean,
  p_action_key uuid,
  p_engage_intent text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_interest_outcome text;
  v_queue_rows integer := 0;
begin
  if p_engage_intent is null
     or p_engage_intent not in ('off', 'draft', 'auto_now', 'auto_queue') then
    raise exception 'invalid pool interest engage intent' using errcode = '22023';
  end if;

  -- 기존 원자 관심 계약을 같은 DB 트랜잭션 안에서 재사용한다. 아래 원장/큐 쓰기가 실패하면
  -- 이 호출 전체가 롤백되므로 interest_click만 남는 부분 커밋은 생기지 않는다.
  v_interest_outcome := public.record_pool_interest(
    p_job_id,
    p_applicant_id,
    p_immediate,
    p_action_key
  );

  if v_interest_outcome <> 'recorded' then
    -- 같은 action의 새 계약 재시도는 이미 저장된 의도를 그대로 사용한다. 재시도 시각이나
    -- kill-switch 변경으로 p_engage_intent가 달라져도 최초 의도를 덮어쓰지 않는다.
    return v_interest_outcome;
  end if;

  if p_engage_intent = 'auto_queue' then
    update public.job_candidates
       set engage_queued_at = coalesce(engage_queued_at, now())
     where job_id = p_job_id
       and applicant_id = p_applicant_id
       and agent_stage is null
       and closed_at is null
       and closed_reason is null;
    get diagnostics v_queue_rows = row_count;
  end if;

  insert into public.pool_interest_engage_intents (
    action_key,
    applicant_id,
    job_id,
    intent,
    queue_created
  ) values (
    p_action_key,
    p_applicant_id,
    p_job_id,
    p_engage_intent,
    v_queue_rows > 0
  );

  return 'recorded';
end;
$$;

create or replace function public.complete_pool_interest_engage_intent(
  p_action_key uuid,
  p_applicant_id bigint,
  p_job_id bigint,
  p_outcome text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_applicant_id bigint;
  v_job_id bigint;
  v_status text;
  v_outcome text;
begin
  if p_action_key is null
     or p_applicant_id is null
     or p_job_id is null
     or p_outcome is null
     or btrim(p_outcome) = ''
     or length(p_outcome) > 100 then
    raise exception 'invalid pool interest engage completion' using errcode = '22023';
  end if;

  select applicant_id, job_id, status, outcome
    into v_applicant_id, v_job_id, v_status, v_outcome
    from public.pool_interest_engage_intents
   where action_key = p_action_key
   for update;

  if not found then
    return 'unavailable';
  end if;
  if v_applicant_id <> p_applicant_id or v_job_id <> p_job_id then
    return 'conflict';
  end if;
  if v_status = 'completed' then
    return case when v_outcome = p_outcome then 'deduped' else 'conflict' end;
  end if;

  update public.pool_interest_engage_intents
     set status = 'completed',
         outcome = p_outcome,
         completed_at = now()
   where action_key = p_action_key;

  return 'recorded';
end;
$$;

create or replace function public.defer_pool_interest_engage_intent(
  p_action_key uuid,
  p_applicant_id bigint,
  p_job_id bigint
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_applicant_id bigint;
  v_job_id bigint;
  v_intent text;
  v_status text;
  v_queue_rows integer := 0;
begin
  if p_action_key is null or p_applicant_id is null or p_job_id is null then
    raise exception 'invalid pool interest engage deferral' using errcode = '22023';
  end if;

  select applicant_id, job_id, intent, status
    into v_applicant_id, v_job_id, v_intent, v_status
    from public.pool_interest_engage_intents
   where action_key = p_action_key
   for update;

  if not found then
    return 'unavailable';
  end if;
  if v_applicant_id <> p_applicant_id or v_job_id <> p_job_id then
    return 'conflict';
  end if;
  if v_status <> 'pending' then
    return 'deduped';
  end if;
  if v_intent = 'auto_queue' then
    return 'deduped';
  end if;
  if v_intent <> 'auto_now' then
    return 'conflict';
  end if;

  update public.job_candidates
     set engage_queued_at = coalesce(engage_queued_at, now())
   where job_id = p_job_id
     and applicant_id = p_applicant_id
     and agent_stage is null
     and closed_at is null
     and closed_reason is null;
  get diagnostics v_queue_rows = row_count;

  update public.pool_interest_engage_intents
     set intent = 'auto_queue',
         queue_created = v_queue_rows > 0
   where action_key = p_action_key;

  return case when v_queue_rows > 0 then 'queued' else 'not_queued' end;
end;
$$;

revoke execute on function public.record_pool_interest_with_engage_intent(bigint, bigint, boolean, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_pool_interest_with_engage_intent(bigint, bigint, boolean, uuid, text)
  to service_role;

revoke execute on function public.complete_pool_interest_engage_intent(uuid, bigint, bigint, text)
  from public, anon, authenticated;
grant execute on function public.complete_pool_interest_engage_intent(uuid, bigint, bigint, text)
  to service_role;

revoke execute on function public.defer_pool_interest_engage_intent(uuid, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.defer_pool_interest_engage_intent(uuid, bigint, bigint)
  to service_role;

comment on table public.pool_interest_engage_intents is
  '풀 관심 저장과 원자 커밋되는 후속 자동응대 의도. 동일 action replay의 복구 근거다.';
comment on function public.record_pool_interest_with_engage_intent(bigint, bigint, boolean, uuid, text) is
  '관심 이벤트·자동응대 의도를 원자 저장하고 야간 자동응대는 후보 큐까지 같은 트랜잭션에서 예약한다.';
comment on function public.complete_pool_interest_engage_intent(uuid, bigint, bigint, text) is
  '외부 동작의 안정된 결과를 동일 action 의도에 멱등 기록한다.';
comment on function public.defer_pool_interest_engage_intent(uuid, bigint, bigint) is
  '주간 의도 복구가 야간에 도달한 경우 SMS 대신 후보 큐와 의도를 원자 전환한다.';
