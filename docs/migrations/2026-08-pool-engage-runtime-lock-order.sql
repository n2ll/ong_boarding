-- P1 repair: 풀 자동응대 결과 기록·finalize의 행 잠금 순서를 복구 RPC와 통일한다.
-- 선행(명시 순서):
--   1. 2026-08-pool-engage-claim.sql
--   2. 2026-08-pool-engage-recovery.sql
-- 후행:
--   3. 2026-08-pool-interest-engage-intent.sql
--
-- reconcile_pool_engage는 applicants → pool_engage_send_requests 순서로 잠근다.
-- 기존 provider-result/finalize는 반대로 outbox → applicants를 잠가, 발송 중 동일 action
-- retry와 공급자 실패 결과가 겹치면 deadlock 뒤 sending 원장이 남을 수 있었다.
-- 두 함수 모두 owner를 비잠금 조회한 뒤 applicants → outbox 순서로 다시 검증·잠근다.

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
  v_lock_applicant_id bigint;
  v_applicant_id bigint;
  v_job_id bigint;
  v_status text;
  v_provider_message_id text;
begin
  if p_action_key is null or p_result not in ('unknown', 'failed', 'sent') then
    raise exception 'invalid provider result' using errcode = '22023';
  end if;

  -- owner를 먼저 읽되 아직 outbox를 잠그지 않는다. 모든 다중 행 경로는
  -- applicants → outbox 순서로만 잠가 reconcile/finalize와 순환 대기를 만들지 않는다.
  select applicant_id
    into v_lock_applicant_id
    from public.pool_engage_send_requests
   where action_key = p_action_key;

  if not found then
    return 'unavailable';
  end if;

  perform 1
    from public.applicants
   where id = v_lock_applicant_id
   for update;

  if not found then
    return 'unavailable';
  end if;

  select applicant_id, job_id, status, provider_message_id
    into v_applicant_id, v_job_id, v_status, v_provider_message_id
    from public.pool_engage_send_requests
   where action_key = p_action_key
   for update;

  if not found or v_applicant_id is distinct from v_lock_applicant_id then
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
  v_lock_applicant_id bigint;
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

  select applicant_id
    into v_lock_applicant_id
    from public.pool_engage_send_requests
   where action_key = p_action_key;

  if not found then
    return 'unavailable';
  end if;

  select pool_engage_action_key, current_job_id, status
    into v_owner_action_key, v_owner_job_id, v_owner_status
    from public.applicants
   where id = v_lock_applicant_id
   for update;

  if not found then
    return 'unavailable';
  end if;

  select applicant_id, job_id, applicant_phone, message_body, message_kind,
         source, status, provider_message_id
    into v_applicant_id, v_job_id, v_phone, v_body, v_kind,
         v_source, v_status, v_provider_message_id
    from public.pool_engage_send_requests
   where action_key = p_action_key
   for update;

  if not found or v_applicant_id is distinct from v_lock_applicant_id then
    return 'unavailable';
  end if;
  if v_status = 'recorded' then
    return 'deduped';
  end if;
  if v_status <> 'sent' then
    return 'unavailable';
  end if;

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

revoke execute on function public.record_pool_engage_provider_result(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_pool_engage_provider_result(uuid, text, text, text)
  to service_role;

revoke execute on function public.finalize_pool_engage(uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_pool_engage(uuid)
  to service_role;

comment on function public.record_pool_engage_provider_result(uuid, text, text, text) is
  '지원자→outbox 잠금 순서로 공급자 결과를 기록해 recovery와의 deadlock을 막는다.';
comment on function public.finalize_pool_engage(uuid) is
  '지원자→outbox 잠금 순서로 sent 원장을 메시지·후보·이벤트에 원자 반영한다.';
