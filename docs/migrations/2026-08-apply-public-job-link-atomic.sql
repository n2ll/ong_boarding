-- 공개 지원서의 공고 후보 연결을 공고 상태 확인과 같은 트랜잭션에서 처리한다.
-- jobs 행을 잠근 뒤 확인하므로, 매니저의 마감 UPDATE와 후보 INSERT가 엇갈려
-- 마감 공고를 성공으로 반환하는 TOCTOU를 막는다.

create or replace function public.link_public_job_candidate(
  p_job_id bigint,
  p_applicant_id bigint,
  p_agent_stage text,
  p_agent_state jsonb,
  p_closed_at timestamptz default null,
  p_closed_reason text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_title text;
  v_exposure text;
  v_recruit_mode text;
  v_closes_at timestamptz;
  v_inserted_applicant_id bigint;
  v_existing_stage text;
  v_existing_closed_at timestamptz;
  v_existing_closed_reason text;
begin
  select status, title, exposure, recruit_mode, closes_at
    into v_status, v_title, v_exposure, v_recruit_mode, v_closes_at
    from public.jobs
   where id = p_job_id
   for update;

  if not found
     or v_status is null
     or v_status <> 'active'
     or v_title is null
     or btrim(v_title) = ''
     or left(v_title, 2) = '__'
     or v_exposure = 'targeted'
     or v_recruit_mode is null
     or v_recruit_mode not in ('external', 'both')
     or v_closes_at <= now() then
    return 'unavailable';
  end if;

  insert into public.job_candidates (
    job_id,
    applicant_id,
    agent_stage,
    agent_state,
    closed_at,
    closed_reason
  ) values (
    p_job_id,
    p_applicant_id,
    p_agent_stage,
    coalesce(p_agent_state, '{}'::jsonb),
    p_closed_at,
    p_closed_reason
  )
  on conflict (job_id, applicant_id) do nothing
  returning applicant_id into v_inserted_applicant_id;

  if found then
    return 'linked';
  end if;

  -- 기존 후보는 덮어쓰지 않는다. 진행 중인 연결만 성공으로 인정하고,
  -- 관리자/자동화가 종료한 후보는 종료 근거를 그대로 보존한다.
  select agent_stage, closed_at, closed_reason
    into v_existing_stage, v_existing_closed_at, v_existing_closed_reason
    from public.job_candidates
   where job_id = p_job_id
     and applicant_id = p_applicant_id
   for update;

  if not found then
    return 'unavailable';
  end if;

  if v_existing_closed_at is null
     and v_existing_closed_reason is null
     and (
       v_existing_stage is null
       or v_existing_stage in ('exploration', 'screening', 'onboarding', 'active', 'paused')
     ) then
    return 'already_linked';
  end if;

  return 'unchanged_closed';
end;
$$;

revoke execute on function public.link_public_job_candidate(bigint, bigint, text, jsonb, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.link_public_job_candidate(bigint, bigint, text, jsonb, timestamptz, text)
  to service_role;

comment on function public.link_public_job_candidate(bigint, bigint, text, jsonb, timestamptz, text)
  is '공개 지원 공고의 모집 상태를 잠금 재검증한 뒤 후보를 원자적으로 연결한다.';
