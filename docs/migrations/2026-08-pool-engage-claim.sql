-- P0: 풀 관심 자동응대의 지원자 단위 선점과 SMS 결과 원장.
-- 서로 다른 공고의 동시 요청도 applicants 행 잠금 아래 한 건만 SMS 경계를 넘는다.
--
-- 상태 계약:
--   sending  : 이 action_key가 지원자를 선점했고 공급자 호출 전/중이다.
--   unknown  : 공급자 결과가 불명확하다. 중복 위험 때문에 자동 재발송하지 않는다.
--   failed   : 공급자가 실패를 확정했고 선점을 해제했다. 새 action_key 재시도만 허용한다.
--   sent     : 공급자 성공을 먼저 보존했다. SMS 없이 finalize만 재시도할 수 있다.
--   recorded : messages·pool_events·후보 상태까지 원자 반영됐다.

alter table public.applicants
  add column if not exists pool_engage_action_key uuid;

create table if not exists public.pool_engage_send_requests (
  action_key uuid primary key,
  applicant_id bigint not null references public.applicants(id) on delete cascade,
  job_id bigint not null references public.jobs(id) on delete cascade,
  applicant_phone text not null,
  message_body text not null,
  message_kind text not null check (message_kind in ('screening', 'waitlist')),
  source text not null,
  status text not null default 'sending'
    check (status in ('sending', 'unknown', 'failed', 'sent', 'recorded')),
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  recorded_at timestamptz
);

create index if not exists pool_engage_send_requests_applicant_created_idx
  on public.pool_engage_send_requests (applicant_id, created_at desc);

alter table public.pool_engage_send_requests enable row level security;
revoke all on table public.pool_engage_send_requests from public, anon, authenticated;
grant select, insert, update on table public.pool_engage_send_requests to service_role;

-- finalize의 messages insert도 같은 action_key로 멱등화한다. 수동 SMS 마이그레이션보다
-- 먼저 적용되는 환경에서도 독립적으로 안전하도록 컬럼/index를 누적 선언한다.
alter table public.messages
  add column if not exists client_request_id uuid;

create unique index if not exists messages_client_request_id_uidx
  on public.messages (client_request_id)
  where client_request_id is not null;

create or replace function public.claim_pool_engage(
  p_job_id bigint,
  p_applicant_id bigint,
  p_action_key uuid,
  p_applicant_phone text,
  p_message_body text,
  p_message_kind text,
  p_source text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_applicant_id bigint;
  v_existing_job_id bigint;
  v_existing_phone text;
  v_existing_body text;
  v_existing_kind text;
  v_existing_source text;
  v_job_id bigint;
  v_job_title text;
  v_job_status text;
  v_job_closes_at timestamptz;
  v_applicant_phone text;
  v_applicant_status text;
  v_sms_opt_out_at timestamptz;
  v_current_job_id bigint;
  v_current_action_key uuid;
  v_candidate_id bigint;
  v_candidate_stage text;
  v_candidate_closed_at timestamptz;
  v_candidate_closed_reason text;
begin
  if p_action_key is null
     or p_applicant_phone is null
     or btrim(p_applicant_phone) = ''
     or p_message_body is null
     or btrim(p_message_body) = ''
     or p_message_kind not in ('screening', 'waitlist')
     or p_source is null
     or btrim(p_source) = '' then
    raise exception 'invalid pool engage claim' using errcode = '22023';
  end if;

  -- 동일 action replay는 모집/후보의 가변 상태보다 먼저 판정한다. 같은 발송 의도면
  -- 어떤 상태에서도 다시 SMS를 허용하지 않고, 다른 의도로 키를 재사용하면 충돌시킨다.
  select applicant_id, job_id, applicant_phone, message_body, message_kind, source
    into v_existing_applicant_id, v_existing_job_id, v_existing_phone,
         v_existing_body, v_existing_kind, v_existing_source
    from public.pool_engage_send_requests
   where action_key = p_action_key
   for update;

  if found then
    if v_existing_applicant_id = p_applicant_id
       and v_existing_job_id = p_job_id
       and v_existing_phone = p_applicant_phone
       and v_existing_body = p_message_body
       and v_existing_kind = p_message_kind
       and v_existing_source = p_source then
      return 'already_claimed';
    end if;
    raise exception 'action key already used' using errcode = '23505';
  end if;

  select id, title, status, closes_at
    into v_job_id, v_job_title, v_job_status, v_job_closes_at
    from public.jobs
   where id = p_job_id
   for share;

  if v_job_id is null
     or v_job_title is null
     or btrim(v_job_title) = ''
     or left(v_job_title, 2) = '__'
     or v_job_status is null
     or v_job_status <> 'active'
     or (v_job_closes_at is not null and v_job_closes_at <= now()) then
    return 'unavailable';
  end if;

  -- 지원자 행이 서로 다른 공고의 claim을 직렬화하는 단일 잠금이다.
  select phone, status, sms_opt_out_at, current_job_id, pool_engage_action_key
    into v_applicant_phone, v_applicant_status, v_sms_opt_out_at,
         v_current_job_id, v_current_action_key
    from public.applicants
   where id = p_applicant_id
   for update;

  if not found
     or v_applicant_phone is null
     or v_applicant_phone <> p_applicant_phone
     or v_applicant_status in ('확정인력', '인력풀 제외')
     or v_sms_opt_out_at is not null then
    return 'unavailable';
  end if;

  if v_current_job_id is null then
    -- 정상 종료/매니저 종료가 current_job_id를 해제했다면 과거 claim은 새 흐름을 막지 않는다.
    null;
  elsif v_current_job_id <> p_job_id then
    return 'job_conflict';
  elsif v_current_action_key is not null then
    -- 같은 공고도 다른 active action이 있으면 다시 보내지 않는다.
    return 'already_claimed';
  end if;

  select id, agent_stage, closed_at, closed_reason
    into v_candidate_id, v_candidate_stage, v_candidate_closed_at, v_candidate_closed_reason
    from public.job_candidates
   where job_id = p_job_id
     and applicant_id = p_applicant_id
   for update;

  if not found
     or v_candidate_stage is not null
     or v_candidate_closed_at is not null
     or v_candidate_closed_reason is not null then
    return 'unavailable';
  end if;

  insert into public.pool_engage_send_requests (
    action_key,
    applicant_id,
    job_id,
    applicant_phone,
    message_body,
    message_kind,
    source,
    status
  ) values (
    p_action_key,
    p_applicant_id,
    p_job_id,
    p_applicant_phone,
    p_message_body,
    p_message_kind,
    p_source,
    'sending'
  );

  update public.applicants
     set current_job_id = p_job_id,
         pool_engage_action_key = p_action_key
   where id = p_applicant_id;

  return 'claimed';
end;
$$;

create or replace function public.record_pool_engage_provider_result(
  p_action_key uuid,
  p_result text,
  p_provider_message_id text default null,
  p_error text default null
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
  v_provider_message_id text;
begin
  if p_action_key is null or p_result not in ('unknown', 'failed', 'sent') then
    raise exception 'invalid provider result' using errcode = '22023';
  end if;

  select applicant_id, job_id, status, provider_message_id
    into v_applicant_id, v_job_id, v_status, v_provider_message_id
    from public.pool_engage_send_requests
   where action_key = p_action_key
   for update;

  if not found then
    return 'unavailable';
  end if;
  if v_status = p_result
     and (p_result <> 'sent' or v_provider_message_id is not distinct from p_provider_message_id) then
    return 'deduped';
  end if;
  if v_status <> 'sending' then
    return 'unchanged';
  end if;

  if p_result = 'unknown' then
    update public.pool_engage_send_requests
       set status = 'unknown',
           last_error = p_error,
           updated_at = now()
     where action_key = p_action_key;
  elsif p_result = 'failed' then
    update public.pool_engage_send_requests
       set status = 'failed',
           last_error = p_error,
           updated_at = now()
     where action_key = p_action_key;

    -- 공급자가 실패를 확정한 경우에만 안전한 새 action 재시도를 위해 소유권을 푼다.
    -- action key 조건이 늦게 도착한 결과가 후속 흐름의 current_job을 지우는 것을 막는다.
    update public.applicants
       set current_job_id = null,
           pool_engage_action_key = null
     where id = v_applicant_id
       and current_job_id = v_job_id
       and pool_engage_action_key = p_action_key
       and status is distinct from '확정인력';
  else
    update public.pool_engage_send_requests
       set status = 'sent',
           provider_message_id = p_provider_message_id,
           last_error = null,
           sent_at = now(),
           updated_at = now()
     where action_key = p_action_key;
  end if;

  return 'recorded';
end;
$$;

create or replace function public.finalize_pool_engage(
  p_action_key uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_applicant_id bigint;
  v_job_id bigint;
  v_phone text;
  v_body text;
  v_kind text;
  v_source text;
  v_status text;
  v_provider_message_id text;
  v_owner_action_key uuid;
  v_owner_job_id bigint;
  v_owner_status text;
  v_candidate_updated integer := 0;
  v_outcome text := 'recorded';
begin
  if p_action_key is null then
    raise exception 'action key is required' using errcode = '22023';
  end if;

  select applicant_id, job_id, applicant_phone, message_body, message_kind,
         source, status, provider_message_id
    into v_applicant_id, v_job_id, v_phone, v_body, v_kind,
         v_source, v_status, v_provider_message_id
    from public.pool_engage_send_requests
   where action_key = p_action_key
   for update;

  if not found then
    return 'unavailable';
  end if;
  if v_status = 'recorded' then
    return 'deduped';
  end if;
  if v_status <> 'sent' then
    return 'unavailable';
  end if;

  select pool_engage_action_key, current_job_id, status
    into v_owner_action_key, v_owner_job_id, v_owner_status
    from public.applicants
   where id = v_applicant_id
   for update;

  insert into public.messages (
    applicant_id,
    applicant_phone,
    direction,
    body,
    status,
    sent_by,
    solapi_msg_id,
    message_type,
    job_id,
    client_request_id
  ) values (
    v_applicant_id,
    v_phone,
    'outbound',
    v_body,
    'sent',
    'agent-engage',
    v_provider_message_id,
    'sms',
    v_job_id,
    p_action_key
  )
  on conflict (client_request_id) where client_request_id is not null do nothing;

  if v_kind = 'waitlist' then
    update public.job_candidates
       set engage_queued_at = null
     where job_id = v_job_id
       and applicant_id = v_applicant_id;

    update public.applicants
       set current_job_id = null,
           pool_engage_action_key = null
     where id = v_applicant_id
       and current_job_id = v_job_id
       and pool_engage_action_key = p_action_key
       and status is distinct from '확정인력';
  elsif v_owner_action_key = p_action_key
        and v_owner_job_id = v_job_id
        and v_owner_status is distinct from '확정인력'
        and v_owner_status is distinct from '인력풀 제외' then
    update public.job_candidates
       set sent_at = now(),
           agent_stage = 'screening',
           engage_queued_at = null
     where job_id = v_job_id
       and applicant_id = v_applicant_id
       and agent_stage is null
       and closed_at is null
       and closed_reason is null;
    get diagnostics v_candidate_updated = row_count;
    if v_candidate_updated = 0 then
      v_outcome := 'superseded';
    end if;
  else
    -- 공급자 성공은 기록하되, 그사이 매니저가 종료/전환한 흐름을 다시 열지는 않는다.
    v_outcome := 'superseded';
  end if;

  insert into public.pool_events (applicant_id, job_id, event_type, meta)
  values (
    v_applicant_id,
    v_job_id,
    case when v_kind = 'waitlist' then 'waitlist_notice' else 'auto_engage' end,
    jsonb_build_object('source', v_source, 'engage_action_key', p_action_key)
  );

  update public.pool_engage_send_requests
     set status = 'recorded',
         recorded_at = now(),
         updated_at = now()
   where action_key = p_action_key;

  return v_outcome;
end;
$$;

revoke execute on function public.claim_pool_engage(bigint, bigint, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_pool_engage(bigint, bigint, uuid, text, text, text, text)
  to service_role;

revoke execute on function public.record_pool_engage_provider_result(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_pool_engage_provider_result(uuid, text, text, text)
  to service_role;

revoke execute on function public.finalize_pool_engage(uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_pool_engage(uuid)
  to service_role;

comment on table public.pool_engage_send_requests is
  '풀 관심 자동응대 SMS 선점/outbox. 지원자 행 잠금으로 서로 다른 공고의 동시 발송을 막는다.';
comment on column public.applicants.pool_engage_action_key is
  '현재 자동응대가 소유한 action key. 늦은 공급자 결과가 후속 흐름을 해제하지 못하게 한다.';
comment on function public.claim_pool_engage(bigint, bigint, uuid, text, text, text, text) is
  '지원자 단위로 자동응대 SMS 권한을 원자 선점한다. current_job 해제 후에는 과거 claim을 대체할 수 있다.';
