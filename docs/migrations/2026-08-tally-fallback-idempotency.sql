-- Tally 직접 폴백도 정식 지원 경로와 동일한 submission UUID/fingerprint 원장을 사용한다.
-- -----------------------------------------------------------------------------
-- 선행(먼저 적용): 2026-08-apply-message-idempotency.sql,
--                  2026-08-apply-submission-mapping.sql,
--                  2026-08-apply-submission-recovery-ledger.sql
--
-- 동일 webhook의 동시 재시도는 advisory lock 아래 한 applicant에만 수렴한다.
-- 정식 /api/apply가 응답 유실 뒤 늦게 완료되는 경쟁도 원장의 최종 winner를 받아들이며,
-- 이 함수가 잠시 만든 미매핑 applicant는 같은 트랜잭션에서 제거한다.

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

  return query select v_applicant_id, v_created;
end;
$$;

revoke all on function public.claim_tally_fallback_submission(uuid, text, jsonb) from public;
revoke execute on function public.claim_tally_fallback_submission(uuid, text, jsonb)
  from anon, authenticated;
grant execute on function public.claim_tally_fallback_submission(uuid, text, jsonb)
  to service_role;
