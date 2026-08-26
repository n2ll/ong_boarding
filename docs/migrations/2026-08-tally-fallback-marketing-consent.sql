-- Tally 정식 지원 경로가 일부 필드 검증에서 실패해 폴백하더라도 명시한
-- 새 일자리 문자 수신 선택을 같은 제출 원장 트랜잭션에서 최종 applicant에 저장한다.
-- 동일 submission replay는 초기에 반환해 이후 수신거부를 되돌리지 않는다.

create or replace function public.claim_tally_fallback_submission(
  p_submission_id uuid,
  p_request_fingerprint text,
  p_applicant jsonb
)
returns table (
  applicant_id bigint,
  created boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_applicant_id bigint;
  v_existing_applicant_id bigint;
  v_existing_fingerprint text;
  v_created boolean := false;
  v_phone text;
begin
  if p_submission_id is null then
    raise exception 'Tally submission UUID is required'
      using errcode = '22023';
  end if;
  if p_request_fingerprint is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'Tally request fingerprint must be a SHA-256 digest'
      using errcode = '22023';
  end if;
  if p_applicant is null or jsonb_typeof(p_applicant) is distinct from 'object' then
    raise exception 'Tally fallback applicant payload is required'
      using errcode = '22023';
  end if;

  v_phone := p_applicant ->> 'phone';
  if v_phone is null or v_phone !~ '^[0-9]{10,11}$' then
    raise exception 'Tally fallback phone is invalid'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('tally-submission:' || p_submission_id::text, 0)
  );

  select mapping.applicant_id, mapping.request_fingerprint
  into v_existing_applicant_id, v_existing_fingerprint
  from public.application_submission_mappings as mapping
  where mapping.submission_id = p_submission_id;

  if found then
    if v_existing_fingerprint is distinct from p_request_fingerprint then
      raise exception 'Tally submission UUID is already mapped to another request'
        using errcode = '23505';
    end if;
    return query select v_existing_applicant_id, false;
    return;
  end if;

  -- 서로 다른 Tally event가 같은 전화번호로 동시에 폴백해도 기존 행을 우선한다.
  perform pg_advisory_xact_lock(hashtextextended('tally-phone:' || v_phone, 0));

  select applicant.id
  into v_applicant_id
  from public.applicants as applicant
  where applicant.phone = v_phone
  order by applicant.id
  limit 1
  for update;

  if v_applicant_id is null then
    insert into public.applicants (
      name,
      phone,
      birth_date,
      location,
      own_vehicle,
      license_type,
      vehicle_type,
      branch1,
      work_hours,
      experience,
      self_ownership,
      available_date,
      status,
      source,
      sido,
      sigungu
    ) values (
      coalesce(nullif(p_applicant ->> 'name', ''), '(이름 미상)'),
      v_phone,
      coalesce(p_applicant ->> 'birth_date', ''),
      coalesce(p_applicant ->> 'location', ''),
      coalesce(p_applicant ->> 'own_vehicle', ''),
      coalesce(p_applicant ->> 'license_type', ''),
      coalesce(p_applicant ->> 'vehicle_type', ''),
      coalesce(nullif(p_applicant ->> 'branch1', ''), '미지정'),
      coalesce(p_applicant ->> 'work_hours', ''),
      nullif(p_applicant ->> 'experience', ''),
      coalesce(p_applicant ->> 'self_ownership', ''),
      nullif(p_applicant ->> 'available_date', ''),
      '스크리닝 전',
      'homepage',
      nullif(p_applicant ->> 'sido', ''),
      nullif(p_applicant ->> 'sigungu', '')
    )
    returning id into v_applicant_id;
    v_created := true;
  end if;

  insert into public.application_submission_mappings (
    submission_id,
    request_fingerprint,
    applicant_id,
    auto_engagement_required
  ) values (
    p_submission_id,
    p_request_fingerprint,
    v_applicant_id,
    false
  )
  on conflict (submission_id) do nothing;

  -- /api/apply가 동시에 원장을 선점했다면 그 winner로 수렴한다.
  select mapping.applicant_id, mapping.request_fingerprint
  into v_existing_applicant_id, v_existing_fingerprint
  from public.application_submission_mappings as mapping
  where mapping.submission_id = p_submission_id;

  if v_existing_fingerprint is distinct from p_request_fingerprint then
    raise exception 'Tally submission UUID is already mapped to another request'
      using errcode = '23505';
  end if;

  if v_existing_applicant_id is distinct from v_applicant_id then
    if v_created then
      delete from public.applicants where id = v_applicant_id;
    end if;
    v_applicant_id := v_existing_applicant_id;
    v_created := false;
  end if;

  -- 최종 원장 winner가 정해진 뒤, 이 신규 submission의 명시 응답만 반영한다.
  -- false는 기존 하드 수신거부 시각을 보존하고 true만 명시 재동의로 해제한다.
  if jsonb_typeof(p_applicant -> 'marketing_consent') = 'boolean' then
    update public.applicants
       set marketing_consent = (p_applicant ->> 'marketing_consent')::boolean,
           marketing_consent_at = case
             when (p_applicant ->> 'marketing_consent')::boolean then now()
             else null
           end,
           sms_opt_out_at = case
             when (p_applicant ->> 'marketing_consent')::boolean then null
             else sms_opt_out_at
           end
     where id = v_applicant_id;
  end if;

  return query select v_applicant_id, v_created;
end;
$$;

revoke all on function public.claim_tally_fallback_submission(uuid, text, jsonb) from public;
revoke execute on function public.claim_tally_fallback_submission(uuid, text, jsonb)
  from anon, authenticated;
grant execute on function public.claim_tally_fallback_submission(uuid, text, jsonb)
  to service_role;

comment on function public.claim_tally_fallback_submission(uuid, text, jsonb)
  is 'Tally 폴백을 제출 원장에 멱등 매핑하고 신규 명시 문자 동의를 최종 지원자에 원자 저장한다.';
