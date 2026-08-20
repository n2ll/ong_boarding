-- P1 repair: 공개 pool action UUID와 messages 멱등 키의 도메인을 분리한다.
-- 선행(명시 순서):
--   1. 2026-08-pool-engage-claim.sql
--   2. 2026-08-pool-engage-recovery.sql
--   3. 2026-08-pool-engage-runtime-lock-order.sql
-- 후행:
--   4. 2026-08-pool-interest-engage-intent.sql
--
-- pool action UUID는 공개 클라이언트가 만든다. 같은 UUID가 지원 접수/수동 SMS의
-- messages.client_request_id에 이미 있으면 기존 finalize는 INSERT를 건너뛴 뒤에도 outbox를
-- recorded로 닫아, 실제 발송된 pool 문자가 대화 원장에서 사라질 수 있었다.
-- 신규 pool 메시지는 action UUID를 그대로 쓰지 않고 도메인 문자열을 포함한 결정적 UUID를 쓴다.
-- 배포 전에 sent까지 간 legacy outbox는 기존 action UUID 메시지의 전체 소유권이 정확히 맞을 때만
-- 그 행을 재사용한다. 어떤 충돌도 outbox를 recorded로 오인하지 않는다.

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
  v_message_client_request_id uuid;
  v_existing_message public.messages%rowtype;
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

  -- runtime-lock-order 계약 유지: 모든 다중 행 경로는 applicants → outbox 순서다.
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

  -- 이 migration 전에 messages INSERT까지만 성공한 sent outbox를 먼저 복구한다.
  -- 같은 외부 UUID의 다른 도메인 메시지는 소유권 지문이 다르므로 절대 재사용하지 않는다.
  select *
    into v_existing_message
    from public.messages
   where client_request_id = p_action_key
   limit 1;

  if found
     and v_existing_message.applicant_id is not distinct from v_applicant_id
     and v_existing_message.applicant_phone is not distinct from v_phone
     and v_existing_message.direction is not distinct from 'outbound'
     and v_existing_message.body is not distinct from v_body
     and v_existing_message.status is not distinct from 'sent'
     and v_existing_message.sent_by is not distinct from 'agent-engage'
     and v_existing_message.solapi_msg_id is not distinct from v_provider_message_id
     and v_existing_message.message_type is not distinct from 'sms'
     and v_existing_message.job_id is not distinct from v_job_id then
    v_message_client_request_id := p_action_key;
  end if;

  if v_message_client_request_id is null then
    v_message_client_request_id := (
      pg_catalog.md5('pool-engage:' || p_action_key::text)
    )::uuid;

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
      v_message_client_request_id
    )
    on conflict (client_request_id) where client_request_id is not null do nothing;

    select *
      into v_existing_message
      from public.messages
     where client_request_id = v_message_client_request_id
     limit 1;

    if not found
       or v_existing_message.applicant_id is distinct from v_applicant_id
       or v_existing_message.applicant_phone is distinct from v_phone
       or v_existing_message.direction is distinct from 'outbound'
       or v_existing_message.body is distinct from v_body
       or v_existing_message.status is distinct from 'sent'
       or v_existing_message.sent_by is distinct from 'agent-engage'
       or v_existing_message.solapi_msg_id is distinct from v_provider_message_id
       or v_existing_message.message_type is distinct from 'sms'
       or v_existing_message.job_id is distinct from v_job_id then
      return 'conflict';
    end if;
  end if;

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
    jsonb_build_object(
      'source', v_source,
      'engage_action_key', p_action_key,
      'message_client_request_id', v_message_client_request_id
    )
  );

  update public.pool_engage_send_requests
     set status = 'recorded',
         recorded_at = now(),
         updated_at = now()
   where action_key = p_action_key;

  return v_outcome;
end;
$$;

revoke execute on function public.finalize_pool_engage(uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_pool_engage(uuid)
  to service_role;

comment on function public.finalize_pool_engage(uuid) is
  '지원자→outbox 잠금 후 pool 전용 결정 키와 전체 지문으로 sent 메시지를 멱등 기록한다.';
