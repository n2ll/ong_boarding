-- P0 repair: 풀 관심 자동응대 outbox 복구와 활성 claim 불변식 강화.
-- 선행: 2026-08-pool-engage-claim.sql
--
-- current_job_id는 매니저 동작으로 해제될 수 있지만 SMS 공급자 상태와 같지 않다.
-- sending/unknown/sent 원장이 남아 있으면 지원자 단위로 새 발송을 막고,
-- sent는 동일 action replay 또는 아침 cron에서 SMS 없이 finalize만 재개한다.

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
  v_existing_status text;
  v_job_id bigint;
  v_job_title text;
  v_job_status text;
  v_job_closes_at timestamptz;
  v_applicant_phone text;
  v_applicant_status text;
  v_sms_opt_out_at timestamptz;
  v_current_job_id bigint;
  v_current_action_key uuid;
  v_active_action_key uuid;
  v_active_status text;
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

create or replace function public.reconcile_pool_engage(
  p_action_key uuid,
  p_applicant_id bigint,
  p_job_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action_key uuid;
  v_owner_applicant_id bigint;
  v_applicant_id bigint;
  v_job_id bigint;
  v_status text;
  v_message_kind text;
  v_finalize_outcome text;
begin
  if p_action_key is null and (p_applicant_id is null or p_job_id is null) then
    raise exception 'action key or applicant/job is required' using errcode = '22023';
  end if;

  if p_action_key is not null then
    -- 먼저 owner를 찾고 applicant → request 순으로 잠근다. 신규 claim과 잠금 순서를 맞춰
    -- sent 복구와 새 공고 선점이 교착하거나 엇갈리지 않게 한다.
    select applicant_id
      into v_owner_applicant_id
      from public.pool_engage_send_requests
     where action_key = p_action_key;

    if not found then
      return jsonb_build_object('outcome', 'missing');
    end if;
    if p_applicant_id is not null and v_owner_applicant_id <> p_applicant_id then
      return jsonb_build_object('outcome', 'missing');
    end if;

    perform 1
      from public.applicants
     where id = v_owner_applicant_id
     for update;

    select action_key, applicant_id, job_id, status, message_kind
      into v_action_key, v_applicant_id, v_job_id, v_status, v_message_kind
      from public.pool_engage_send_requests
     where action_key = p_action_key
       and (p_job_id is null or job_id = p_job_id)
     for update;
  else
    perform 1
      from public.applicants
     where id = p_applicant_id
     for update;
    if not found then
      return jsonb_build_object('outcome', 'missing');
    end if;

    select action_key, applicant_id, job_id, status, message_kind
      into v_action_key, v_applicant_id, v_job_id, v_status, v_message_kind
      from public.pool_engage_send_requests
     where applicant_id = p_applicant_id
       and status in ('sending', 'unknown', 'sent')
     order by
       case status when 'sent' then 0 when 'unknown' then 1 else 2 end,
       created_at asc
     limit 1
     for update;
  end if;

  if not found then
    return jsonb_build_object('outcome', 'missing');
  end if;

  if v_status = 'sent' then
    -- 공급자 호출은 절대 반복하지 않는다. 기존 sent 원장만 후보/메시지 원장으로 마무리한다.
    v_finalize_outcome := public.finalize_pool_engage(v_action_key);
    if v_finalize_outcome in ('recorded', 'deduped', 'superseded') then
      return jsonb_build_object(
        'outcome', 'recovered',
        'message_kind', v_message_kind,
        'finalize_outcome', v_finalize_outcome
      );
    end if;
    return jsonb_build_object(
      'outcome', 'sent_unfinalized',
      'message_kind', v_message_kind,
      'finalize_outcome', v_finalize_outcome
    );
  end if;

  if v_status = 'unknown' then
    return jsonb_build_object('outcome', 'unknown', 'message_kind', v_message_kind);
  end if;
  if v_status = 'sending' then
    return jsonb_build_object('outcome', 'sending', 'message_kind', v_message_kind);
  end if;
  if v_status = 'recorded' then
    return jsonb_build_object('outcome', 'recorded', 'message_kind', v_message_kind);
  end if;
  if v_status = 'failed' then
    return jsonb_build_object('outcome', 'failed', 'message_kind', v_message_kind);
  end if;

  return jsonb_build_object('outcome', 'missing');
end;
$$;

revoke execute on function public.claim_pool_engage(bigint, bigint, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_pool_engage(bigint, bigint, uuid, text, text, text, text)
  to service_role;

revoke execute on function public.reconcile_pool_engage(uuid, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.reconcile_pool_engage(uuid, bigint, bigint)
  to service_role;

comment on function public.claim_pool_engage(bigint, bigint, uuid, text, text, text, text) is
  '지원자 단위 활성 outbox(sending/unknown/sent)를 우선 검사하고 sent 동일 action은 finalize 전용으로 재개한다.';
comment on function public.reconcile_pool_engage(uuid, bigint, bigint) is
  '동일 action 또는 지원자/공고의 sent 자동응대를 SMS 없이 finalize하고 불명 상태를 조회한다.';
