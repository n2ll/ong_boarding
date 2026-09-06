-- 선행: 2026-08-pool-interest-engage-intent.sql 및 그 파일에 명시한 선행 migration.
-- 대화 초점은 확정/배정과 별개다. 확정인력의 current_job_id는 이 RPC로 바꾸지 않는다.
-- 새 앱 배포 전에 적용한다. 되돌릴 때는 새 호출을 중단하고 RPC execute를 회수한다.
-- 초점·관심 감사 이력은 보존하며, reply claim은 운영자가 실행 종료를 확인한 뒤 해제한다.

alter table public.applicants
  add column if not exists conversation_focus_job_id bigint references public.jobs(id) on delete set null,
  add column if not exists conversation_focus_at timestamptz,
  add column if not exists conversation_focus_action_key uuid,
  add column if not exists agent_reply_claim_key uuid,
  add column if not exists agent_reply_claimed_at timestamptz;

alter table public.messages add column if not exists agent_reply_deferred_at timestamptz;

comment on column public.applicants.conversation_focus_job_id is
  '지원자가 명시적으로 고른 SMS 대화 공고. 근무 확정/배정과 별개이며 null이면 기존 라우팅을 따른다.';
comment on column public.applicants.conversation_focus_at is
  '명시적 대화 초점 선택 시각. 이전에 수신된 문자가 복구되더라도 새 공고 응답으로 사용하지 않는다.';
comment on column public.applicants.conversation_focus_action_key is
  '현재 대화 선택의 action 세대. 같은 공고로 돌아와도 이전 관심/자동응대 요청을 재실행하지 않는다.';
comment on column public.applicants.agent_reply_claim_key is
  '지원자 단위 AI 응답 실행 소유권. 같은 key도 재실행 불가. 자동 만료/탈취 없이 운영자 확인 후 해제한다.';
comment on column public.applicants.agent_reply_claimed_at is
  '응답 실행 선점 시각. 운영 점검용이며 자동 lease 만료 기준으로 사용하지 않는다.';
comment on column public.messages.agent_reply_deferred_at is
  '지원자 응답/초기 발송 선점 때문에 처리되지 못한 수신 문자. 해당 응답 소유자만 완료 시 지운다.';

-- 선택 인자를 추가할 때 이전 overload를 남기면 PostgREST/SQL의 기본 인자 해석이 모호해진다.
drop function if exists public.claim_pool_agent_reply(bigint, bigint, uuid, timestamptz);
drop function if exists public.release_pool_agent_reply(bigint, uuid);

create or replace function public.claim_pool_agent_reply(
  p_applicant_id bigint,
  p_job_id bigint,
  p_claim_key uuid,
  p_received_at timestamptz default null,
  p_inbound_message_id text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_applicant public.applicants%rowtype;
begin
  if p_applicant_id is null or p_job_id is null or p_claim_key is null then
    raise exception 'invalid pool agent reply claim' using errcode = '22023';
  end if;

  select * into v_applicant
    from public.applicants where id = p_applicant_id for update;
  if not found
     or v_applicant.status in ('인력풀 제외', '부적합', '이탈')
     or v_applicant.sms_opt_out_at is not null then
    return 'unavailable';
  end if;
  if v_applicant.agent_reply_claim_key is not null or exists (
    select 1 from public.pool_engage_send_requests
     where applicant_id = p_applicant_id and status in ('sending', 'unknown', 'sent')
  ) then
    -- 같은 key의 HTTP/worker 재시도도 두 번째 응답 실행 권한을 얻지 못한다.
    update public.messages set agent_reply_deferred_at = clock_timestamp()
     where id::text = p_inbound_message_id
       and applicant_id = p_applicant_id and direction = 'inbound';
    return 'busy';
  end if;
  if v_applicant.conversation_focus_job_id is not null and (
    v_applicant.conversation_focus_job_id <> p_job_id or p_received_at is null
    or p_received_at < v_applicant.conversation_focus_at
  ) then
    return 'job_conflict';
  end if;

  update public.applicants
     set agent_reply_claim_key = p_claim_key, agent_reply_claimed_at = now()
   where id = p_applicant_id;
  return 'claimed';
end;
$$;

create or replace function public.release_pool_agent_reply(
  p_applicant_id bigint,
  p_claim_key uuid,
  p_inbound_message_id text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_applicant_id is null or p_claim_key is null then
    raise exception 'invalid pool agent reply release' using errcode = '22023';
  end if;
  update public.applicants
     set agent_reply_claim_key = null, agent_reply_claimed_at = null
   where id = p_applicant_id and agent_reply_claim_key = p_claim_key;
  if not found then return 'not_owner'; end if;
  -- 지원자 잠금을 유지한 채 해당 실행의 문자만 완료한다. 나중에 온 문자는 복구 대상으로 남긴다.
  update public.messages set agent_reply_deferred_at = null
   where id::text = p_inbound_message_id
     and applicant_id = p_applicant_id and direction = 'inbound';
  return 'released';
end;
$$;

create or replace function public.select_pool_conversation_focus(
  p_job_id bigint,
  p_applicant_id bigint,
  p_action_key uuid,
  p_engage_intent text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.pool_events%rowtype;
  v_job public.jobs%rowtype;
  v_applicant public.applicants%rowtype;
  v_candidate public.job_candidates%rowtype;
  v_outcome text;
  v_effective_intent text;
begin
  if p_job_id is null or p_applicant_id is null or p_action_key is null
     or p_engage_intent is null
     or p_engage_intent not in ('off', 'draft', 'auto_now', 'auto_queue') then
    raise exception 'invalid pool conversation focus' using errcode = '22023';
  end if;

  -- 기존 interest RPC와 같은 action → job → applicant 잠금 순서를 유지한다.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_action_key::text, 0));
  select * into v_event from public.pool_events where action_key = p_action_key;
  if found then
    if v_event.applicant_id = p_applicant_id and v_event.job_id = p_job_id
       and v_event.event_type = 'interest_click'
       and v_event.meta ->> 'conversation_focus' = 'true'
       and coalesce(v_event.meta ->> 'interest_only', 'false') = 'false' then
      -- 뒤에 선택한 공고와 가변 상태를 절대 덮어쓰지 않는다. 최초 intent도 보존한다.
      return 'deduped';
    end if;
    raise exception 'action key already used' using errcode = '23505';
  end if;

  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.status is distinct from 'active'
     or v_job.title is null or btrim(v_job.title) = '' or left(v_job.title, 2) = '__'
     or v_job.recruit_mode is null or v_job.recruit_mode not in ('internal', 'both')
     or v_job.closes_at <= now() then
    return 'unavailable';
  end if;

  select * into v_applicant from public.applicants where id = p_applicant_id for update;
  if not found or v_applicant.status in ('확정인력', '인력풀 제외', '부적합', '이탈')
     or v_applicant.sms_opt_out_at is not null then
    return 'unavailable';
  end if;
  if exists (
    select 1 from public.job_exposure_targets
     where job_id = p_job_id and applicant_id = p_applicant_id and mode = 'exclude'
  ) then
    return 'unavailable';
  end if;

  if v_applicant.agent_reply_claim_key is not null or exists (
    select 1 from public.pool_engage_send_requests
     where applicant_id = p_applicant_id and status in ('sending', 'unknown', 'sent')
  ) then
    return 'busy';
  end if;
  -- 원장이 없는 오래된 owner pointer도 결과를 추측해서 지우지 않는다.
  if v_applicant.pool_engage_action_key is not null and not exists (
    select 1 from public.pool_engage_send_requests
     where action_key = v_applicant.pool_engage_action_key
       and applicant_id = p_applicant_id and status in ('failed', 'recorded')
  ) then
    return 'busy';
  end if;

  select * into v_candidate from public.job_candidates
   where job_id = p_job_id and applicant_id = p_applicant_id for update;
  if found and (
    v_candidate.closed_at is not null or v_candidate.closed_reason is not null
    or (v_candidate.agent_stage is not null
        and v_candidate.agent_stage not in ('exploration', 'screening', 'onboarding', 'active'))
  ) then
    -- 관심만 저장의 manager: 보류 복원 계약과 달리 대화 전환은 종료/보류를 풀지 않는다.
    return 'unchanged_closed';
  end if;

  v_effective_intent := case when v_candidate.agent_stage is not null then 'off' else p_engage_intent end;
  v_outcome := public.record_pool_interest_with_engage_intent(
    p_job_id, p_applicant_id, false, p_action_key, v_effective_intent
  );
  if v_outcome <> 'recorded' then return v_outcome; end if;

  update public.pool_events
     set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
       'conversation_focus', true,
       'from_job_id', coalesce(v_applicant.conversation_focus_job_id, v_applicant.current_job_id)
     )
   where action_key = p_action_key;
  update public.applicants
     set conversation_focus_job_id = p_job_id,
         conversation_focus_at = clock_timestamp(),
         conversation_focus_action_key = p_action_key,
         current_job_id = p_job_id,
         pool_engage_action_key = null
   where id = p_applicant_id;
  update public.job_candidates set engage_queued_at = null
   where applicant_id = p_applicant_id and engage_queued_at is not null
     and (job_id <> p_job_id or v_effective_intent in ('off', 'draft'));
  return 'recorded';
end;
$$;

create or replace function public.record_pool_interest_only(
  p_job_id bigint,
  p_applicant_id bigint,
  p_immediate boolean,
  p_action_key uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.pool_events%rowtype;
  v_outcome text;
begin
  if p_job_id is null or p_applicant_id is null or p_immediate is null or p_action_key is null then
    raise exception 'invalid pool interest only request' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_action_key::text, 0));
  select * into v_event from public.pool_events where action_key = p_action_key;
  if found then
    if v_event.applicant_id = p_applicant_id and v_event.job_id = p_job_id
       and v_event.event_type = 'interest_click' and v_event.meta ->> 'interest_only' = 'true'
       and coalesce(v_event.meta ->> 'conversation_focus', 'false') = 'false'
       and coalesce(v_event.meta ->> 'immediate', 'false') = p_immediate::text then
      return 'deduped';
    end if;
    raise exception 'action key already used' using errcode = '23505';
  end if;

  perform 1 from public.jobs where id = p_job_id for update;
  if not found then return 'unavailable'; end if;
  perform 1 from public.applicants where id = p_applicant_id for update;
  if not found then return 'unavailable'; end if;
  v_outcome := public.record_pool_interest_with_engage_intent(
    p_job_id, p_applicant_id, p_immediate, p_action_key, 'off'
  );
  if v_outcome = 'recorded' then
    update public.pool_events
       set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('interest_only', true)
     where action_key = p_action_key;
  end if;
  return v_outcome;
end;
$$;

revoke execute on function public.claim_pool_agent_reply(bigint, bigint, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.claim_pool_agent_reply(bigint, bigint, uuid, timestamptz, text) to service_role;
revoke execute on function public.release_pool_agent_reply(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.release_pool_agent_reply(bigint, uuid, text) to service_role;
revoke execute on function public.select_pool_conversation_focus(bigint, bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.select_pool_conversation_focus(bigint, bigint, uuid, text) to service_role;
revoke execute on function public.record_pool_interest_only(bigint, bigint, boolean, uuid) from public, anon, authenticated;
grant execute on function public.record_pool_interest_only(bigint, bigint, boolean, uuid) to service_role;


-- 기존 claim의 공급자 재시도/원장 계약을 보존하며 초점과 응답 소유권 검사를 더한다.
drop function if exists public.claim_pool_engage(bigint, bigint, uuid, text, text, text, text);
create or replace function public.claim_pool_engage(
  p_job_id bigint,
  p_applicant_id bigint,
  p_action_key uuid,
  p_applicant_phone text,
  p_message_body text,
  p_message_kind text,
  p_source text,
  p_focus_action_key uuid default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing_applicant_id bigint;
  v_existing_job_id bigint;
  v_existing_phone text;
  v_existing_body text;
  v_existing_kind text;
  v_existing_source text;
  v_existing_status text;
  v_job_id bigint;
  v_job_title text;
  v_job_status text;
  v_job_closes_at timestamptz;
  v_applicant_phone text;
  v_applicant_status text;
  v_sms_opt_out_at timestamptz;
  v_current_job_id bigint;
  v_conversation_focus_job_id bigint;
  v_conversation_focus_action_key uuid;
  v_agent_reply_claim_key uuid;
  v_current_action_key uuid;
  v_active_action_key uuid;
  v_active_status text;
  v_candidate_id bigint;
  v_candidate_stage text;
  v_candidate_closed_at timestamptz;
  v_candidate_closed_reason text;
  v_candidate_queued_at timestamptz;
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

  -- 동일 action replay는 공급자를 다시 호출하지 않는다. sent만 finalize 전용으로 재개한다.
  select applicant_id, job_id, applicant_phone, message_body, message_kind, source, status
    into v_existing_applicant_id, v_existing_job_id, v_existing_phone,
         v_existing_body, v_existing_kind, v_existing_source, v_existing_status
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
      if v_existing_status = 'sent' then
        return 'resume_finalize';
      end if;
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

  -- 지원자 행을 먼저 잠가 서로 다른 공고의 claim/reconcile을 같은 순서로 직렬화한다.
  select phone, status, sms_opt_out_at, current_job_id, pool_engage_action_key,
         conversation_focus_job_id, conversation_focus_action_key, agent_reply_claim_key
    into v_applicant_phone, v_applicant_status, v_sms_opt_out_at,
         v_current_job_id, v_current_action_key,
         v_conversation_focus_job_id, v_conversation_focus_action_key, v_agent_reply_claim_key
    from public.applicants
   where id = p_applicant_id
   for update;

  if not found
     or v_applicant_phone is null
     or v_applicant_phone <> p_applicant_phone
     or v_applicant_status in ('확정인력', '인력풀 제외', '부적합', '이탈')
     or v_sms_opt_out_at is not null then
    return 'unavailable';
  end if;

  -- 기존 current_job_id가 해제돼도 명시적 초점과 실행 중인 응답 소유권을 존중한다.
  if v_conversation_focus_job_id is not null then
    -- B → C → B에서도 최초 B 요청은 실행 권한을 다시 얻지 않는다.
    -- cron은 공급자가 명시적으로 실패한 뒤 새 발송 key로 재시도하되 같은 선택 세대를 증명한다.
    if v_conversation_focus_job_id <> p_job_id
       or v_conversation_focus_action_key is distinct from
         (case when p_source = 'engage_queued_cron' then p_focus_action_key else p_action_key end)
       or not exists (
         select 1 from public.pool_interest_engage_intents
          where action_key = v_conversation_focus_action_key
            and applicant_id = p_applicant_id and job_id = p_job_id
            and intent in ('auto_now', 'auto_queue')
       ) then
      return 'job_conflict';
    end if;
  end if;
  if v_agent_reply_claim_key is not null then
    return 'already_claimed';
  end if;

  -- current_job_id나 owner pointer가 외부 동작으로 먼저 지워졌어도 outbox가 진실의 원장이다.
  -- failed/recorded는 종결 상태이므로 정상 종료 뒤 새 관심 흐름을 막지 않는다.
  select action_key, status
    into v_active_action_key, v_active_status
    from public.pool_engage_send_requests
   where applicant_id = p_applicant_id
     and status in ('sending', 'unknown', 'sent')
   order by created_at asc
   limit 1
   for update;

  if found then
    return 'already_claimed';
  end if;

  if v_current_job_id is null then
    -- 이전 failed/recorded 흐름이 정상 종결된 뒤에는 새 공고 선점을 허용한다.
    null;
  elsif v_current_job_id <> p_job_id then
    return 'job_conflict';
  elsif v_current_action_key is not null then
    return 'already_claimed';
  end if;

  select id, agent_stage, closed_at, closed_reason, engage_queued_at
    into v_candidate_id, v_candidate_stage, v_candidate_closed_at, v_candidate_closed_reason, v_candidate_queued_at
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
  if p_source = 'engage_queued_cron' and v_candidate_queued_at is null then
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

revoke execute on function public.claim_pool_engage(bigint, bigint, uuid, text, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_pool_engage(bigint, bigint, uuid, text, text, text, text, uuid)
  to service_role;

-- 주간 auto_now 복구가 야간으로 넘어가도 이전 선택의 큐를 되살리지 않는다.
create or replace function public.defer_pool_interest_engage_intent(
  p_action_key uuid,
  p_applicant_id bigint,
  p_job_id bigint
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_applicant_id bigint;
  v_job_id bigint;
  v_focus_job_id bigint;
  v_focus_action_key uuid;
  v_intent text;
  v_status text;
  v_queue_rows integer := 0;
begin
  if p_action_key is null or p_applicant_id is null or p_job_id is null then
    raise exception 'invalid pool interest engage deferral' using errcode = '22023';
  end if;

  -- focus/claim과 같은 applicant → intent/candidate 순서로 직렬화한다.
  select conversation_focus_job_id, conversation_focus_action_key
    into v_focus_job_id, v_focus_action_key
    from public.applicants where id = p_applicant_id for update;
  if not found then return 'unavailable'; end if;
  if v_focus_job_id is not null and (
    v_focus_job_id <> p_job_id or v_focus_action_key is distinct from p_action_key
  ) then
    return 'not_queued';
  end if;

  select applicant_id, job_id, intent, status
    into v_applicant_id, v_job_id, v_intent, v_status
    from public.pool_interest_engage_intents
   where action_key = p_action_key for update;
  if not found then return 'unavailable'; end if;
  if v_applicant_id <> p_applicant_id or v_job_id <> p_job_id then
    return 'conflict';
  end if;
  if v_status <> 'pending' then return 'deduped'; end if;
  if v_intent = 'auto_queue' then return 'deduped'; end if;
  if v_intent <> 'auto_now' then return 'conflict'; end if;

  update public.job_candidates
     set engage_queued_at = coalesce(engage_queued_at, now())
   where job_id = p_job_id
     and applicant_id = p_applicant_id
     and agent_stage is null
     and closed_at is null
     and closed_reason is null;
  get diagnostics v_queue_rows = row_count;

  update public.pool_interest_engage_intents
     set intent = 'auto_queue', queue_created = v_queue_rows > 0
   where action_key = p_action_key;
  return case when v_queue_rows > 0 then 'queued' else 'not_queued' end;
end;
$$;

revoke execute on function public.defer_pool_interest_engage_intent(uuid, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.defer_pool_interest_engage_intent(uuid, bigint, bigint)
  to service_role;

-- 오래된 응대 snapshot의 큐 정리가 같은 공고의 새 선택을 취소하지 않게 한다.
create or replace function public.clear_pool_engage_queue(
  p_candidate_id bigint,
  p_expected_focus_action_key uuid default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_applicant_id bigint;
  v_job_id bigint;
  v_focus_job_id bigint;
  v_focus_action_key uuid;
begin
  if p_candidate_id is null then
    raise exception 'invalid pool engage queue cleanup' using errcode = '22023';
  end if;
  -- candidate를 먼저 잠그지 않는다. 모든 변경 경로의 applicant → candidate 순서를 유지한다.
  select applicant_id, job_id into v_applicant_id, v_job_id
    from public.job_candidates where id = p_candidate_id;
  if not found then return 'unavailable'; end if;
  select conversation_focus_job_id, conversation_focus_action_key
    into v_focus_job_id, v_focus_action_key
    from public.applicants where id = v_applicant_id for update;
  if not found then return 'unavailable'; end if;
  if v_focus_action_key is distinct from p_expected_focus_action_key
     or (v_focus_job_id is not null and v_focus_job_id <> v_job_id) then
    return 'superseded';
  end if;
  update public.job_candidates set engage_queued_at = null
   where id = p_candidate_id and applicant_id = v_applicant_id and job_id = v_job_id;
  return case when found then 'cleared' else 'unavailable' end;
end;
$$;

revoke execute on function public.clear_pool_engage_queue(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.clear_pool_engage_queue(bigint, uuid)
  to service_role;
