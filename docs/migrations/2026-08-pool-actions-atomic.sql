-- 지원자 풀 페이지의 관심/다음 기회 알림을 원자적·멱등적으로 저장한다.
-- HTTP 응답이 유실되어 같은 action_key로 재시도해도 이벤트와 후속 알림이 중복되지 않는다.

alter table public.pool_events
  add column if not exists action_key uuid;

create unique index if not exists pool_events_action_key_unique_idx
  on public.pool_events (action_key)
  where action_key is not null;

create or replace function public.record_pool_interest(
  p_job_id bigint,
  p_applicant_id bigint,
  p_immediate boolean,
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
  v_exposure text;
  v_previous_availability text;
  v_existing_applicant_id bigint;
  v_existing_job_id bigint;
  v_existing_event_type text;
  v_existing_meta jsonb;
  v_candidate_stage text;
  v_candidate_closed_at timestamptz;
  v_candidate_closed_reason text;
begin
  if p_action_key is null then
    raise exception 'action key is required' using errcode = '22023';
  end if;

  -- 같은 키의 동시 재시도를 직렬화한 뒤, 현재 공고 상태보다 먼저 완료된 요청을 확인한다.
  -- 첫 응답이 유실된 사이 공고가 마감되어도 같은 요청은 정직하게 dedup 성공한다.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_action_key::text, 0)
  );

  select applicant_id, job_id, event_type, meta
    into v_existing_applicant_id, v_existing_job_id, v_existing_event_type, v_existing_meta
    from public.pool_events
   where action_key = p_action_key;

  if found then
    if v_existing_applicant_id = p_applicant_id
       and v_existing_job_id = p_job_id
       and v_existing_event_type = 'interest_click'
       and coalesce(v_existing_meta ->> 'immediate', 'false') = p_immediate::text then
      return 'deduped';
    end if;
    raise exception 'action key already used' using errcode = '23505';
  end if;

  -- 신규 요청만 현재 모집 상태를 잠금 재검증한다.
  select id, title, status, closes_at, recruit_mode, exposure
    into v_job_id, v_title, v_status, v_closes_at, v_recruit_mode, v_exposure
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
     or v_closes_at <= now() then
    return 'unavailable';
  end if;

  select availability
    into v_previous_availability
    from public.applicants
   where id = p_applicant_id
   for update;

  if not found then
    return 'unavailable';
  end if;

  insert into public.job_candidates (job_id, applicant_id)
  values (p_job_id, p_applicant_id)
  on conflict (job_id, applicant_id) do nothing;

  select agent_stage, closed_at, closed_reason
    into v_candidate_stage, v_candidate_closed_at, v_candidate_closed_reason
    from public.job_candidates
   where job_id = p_job_id
     and applicant_id = p_applicant_id
   for update;

  if not found then
    return 'unavailable';
  end if;

  -- 명시적 매니저 보류 외의 종료 근거는 관심 클릭으로 되돌리지 않는다.
  -- interest_click도 기록하지 않아 실제 검토 큐에 없는 후보를 '전달 완료'로 오표시하지 않는다.
  if (
    v_candidate_stage = 'abort'
    or v_candidate_closed_at is not null
    or v_candidate_closed_reason is not null
  ) and not (
    v_candidate_stage = 'abort'
    and v_candidate_closed_reason = 'manager: 보류'
  ) then
    return 'unchanged_closed';
  end if;

  -- 진행 중·부적합·기타 종료 후보는 건드리지 않는다. 미처리 후보와 매니저가 명시적으로
  -- '보류'한 후보만 다시 검토 목록에 올리고, 보류 후보의 종료 근거는 함께 원자 해제한다.
  update public.job_candidates
     set contacted_at = null,
         agent_stage = null,
         closed_at = null,
         closed_reason = null
   where job_id = p_job_id
     and applicant_id = p_applicant_id
     and (
       (agent_stage is null and closed_at is null and closed_reason is null)
       or (agent_stage = 'abort' and closed_reason = 'manager: 보류')
     );

  -- 지정 노출 공고는 관심을 남긴 뒤에도 본인 링크에서 사라지지 않게 한다.
  -- 기존 exclude 행은 unique 충돌로 보존되어 매니저 결정을 되돌리지 않는다.
  if v_exposure = 'targeted' then
    insert into public.job_exposure_targets (job_id, applicant_id, mode, added_by)
    values (p_job_id, p_applicant_id, 'include', 'auto_linked')
    on conflict (job_id, applicant_id) do nothing;
  end if;

  if p_immediate and v_previous_availability is distinct from '즉시가능' then
    update public.applicants
       set availability = '즉시가능',
           availability_updated_at = now()
     where id = p_applicant_id;
  end if;

  insert into public.pool_events (
    applicant_id,
    job_id,
    event_type,
    meta,
    action_key
  ) values (
    p_applicant_id,
    p_job_id,
    'interest_click',
    case when p_immediate then jsonb_build_object('immediate', true) else null end,
    p_action_key
  );

  if p_immediate and v_previous_availability is distinct from '즉시가능' then
    insert into public.pool_events (applicant_id, event_type, meta)
    values (
      p_applicant_id,
      'availability_set',
      jsonb_build_object(
        'from', v_previous_availability,
        'to', '즉시가능',
        'source', 'pull',
        'immediate', true
      )
    );
  end if;

  return 'recorded';
end;
$$;

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
begin
  if p_action_key is null then
    raise exception 'action key is required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_action_key::text, 0)
  );

  select applicant_id, job_id, event_type
    into v_existing_applicant_id, v_existing_job_id, v_existing_event_type
    from public.pool_events
   where action_key = p_action_key;

  if found then
    if v_existing_applicant_id = p_applicant_id
       and v_existing_job_id = p_job_id
       and v_existing_event_type = 'notify_request' then
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

  perform 1
    from public.applicants
   where id = p_applicant_id
   for update;
  if not found then
    return 'unavailable';
  end if;

  -- 이 알림은 공고당 한 번만 필요하다. 공고 행 잠금 아래 확인해 동시 클릭도 중복되지 않는다.
  perform 1
    from public.pool_events
   where applicant_id = p_applicant_id
     and job_id = p_job_id
     and event_type = 'notify_request'
   limit 1;
  if found then
    return 'deduped';
  end if;

  insert into public.pool_events (
    applicant_id,
    job_id,
    event_type,
    action_key
  ) values (
    p_applicant_id,
    p_job_id,
    'notify_request',
    p_action_key
  );

  return 'recorded';
end;
$$;

revoke execute on function public.record_pool_interest(bigint, bigint, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.record_pool_interest(bigint, bigint, boolean, uuid)
  to service_role;

revoke execute on function public.record_pool_notify_request(bigint, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.record_pool_notify_request(bigint, bigint, uuid)
  to service_role;

comment on function public.record_pool_interest(bigint, bigint, boolean, uuid)
  is '풀 관심 후보 연결·재부상·명시 가용성·이벤트를 한 트랜잭션으로 저장한다.';
comment on function public.record_pool_notify_request(bigint, bigint, uuid)
  is '마감 공고의 다음 기회 알림 요청을 멱등적으로 저장한다.';
