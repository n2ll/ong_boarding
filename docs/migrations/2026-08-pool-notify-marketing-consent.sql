-- 마감 공고 카드의 명시적 "새 일자리 문자 안내" 요청을 광고성 SMS 수신 동의로 함께 기록한다.
-- 새 요청이 원자적으로 기록된 경우에만 최신 명시 동의로 보고 기존 수신거부를 해제한다.

create or replace function public.record_pool_notify_request(
  p_job_id bigint,
  p_applicant_id bigint,
  p_action_key uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id bigint;
  v_title text;
  v_status text;
  v_closes_at timestamptz;
  v_recruit_mode text;
  v_existing_applicant_id bigint;
  v_existing_job_id bigint;
  v_existing_event_type text;
  v_marketing_consent boolean;
  v_sms_opt_out_at timestamptz;
begin
  if p_action_key is null then
    raise exception 'action key is required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_action_key::text, 0)
  );

  -- 응답이 유실된 요청은 바뀔 수 있는 공고 상태보다 먼저 복구한다.
  select applicant_id, job_id, event_type
    into v_existing_applicant_id, v_existing_job_id, v_existing_event_type
    from public.pool_events
   where action_key = p_action_key;

  if found then
    if v_existing_applicant_id = p_applicant_id
       and v_existing_job_id = p_job_id
       and v_existing_event_type = 'notify_request' then
      -- 과거 요청의 재전송이 그 뒤의 수신거부를 덮어쓰면 안 된다.
      return 'deduped';
    end if;
    raise exception 'action key already used' using errcode = '23505';
  end if;

  select id, title, status, closes_at, recruit_mode
    into v_job_id, v_title, v_status, v_closes_at, v_recruit_mode
    from public.jobs
   where id = p_job_id
   for update;

  if v_job_id is null
     or v_status is null
     or v_status <> 'active'
     or v_title is null
     or btrim(v_title) = ''
     or left(v_title, 2) = '__'
     or v_recruit_mode is null
     or v_recruit_mode not in ('internal', 'both')
     or v_closes_at is null
     or v_closes_at > now()
     or v_closes_at <= now() - interval '3 days' then
    return 'unavailable';
  end if;

  select marketing_consent, sms_opt_out_at
    into v_marketing_consent, v_sms_opt_out_at
    from public.applicants
   where id = p_applicant_id
   for update;
  if not found then
    return 'unavailable';
  end if;

  -- 같은 공고에 이미 신청했고 현재 동의도 유효하면 중복 처리한다. 과거 이벤트만 남고
  -- 동의가 없거나 이후 수신거부한 경우에는 새 action_key의 이번 클릭을 명시적 재동의로 기록한다.
  perform 1
    from public.pool_events
   where applicant_id = p_applicant_id
     and job_id = p_job_id
     and event_type = 'notify_request'
   limit 1;
  if found
     and v_marketing_consent is true
     and v_sms_opt_out_at is null then
    return 'deduped';
  end if;

  insert into public.pool_events (
    applicant_id,
    job_id,
    event_type,
    action_key,
    meta
  ) values (
    p_applicant_id,
    p_job_id,
    'notify_request',
    p_action_key,
    jsonb_build_object(
      'consent_purpose', 'new_job_sms',
      'consent_channel', 'public_pool_card',
      'consent_version', 'pool_notify_v1'
    )
  );

  -- 새 이벤트와 같은 트랜잭션에서만 최신 명시 동의를 남긴다.
  update public.applicants
     set marketing_consent = true,
         marketing_consent_at = now(),
         sms_opt_out_at = null
   where id = p_applicant_id;

  return 'recorded';
end;
$$;

revoke execute on function public.record_pool_notify_request(bigint, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.record_pool_notify_request(bigint, bigint, uuid)
  to service_role;

comment on function public.record_pool_notify_request(bigint, bigint, uuid)
  is '마감 공고의 다음 일자리 문자 안내 요청과 명시적 수신 동의를 멱등적으로 저장한다.';
