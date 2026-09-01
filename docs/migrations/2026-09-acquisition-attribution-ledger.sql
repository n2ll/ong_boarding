-- 지원 유입 링크와 제출별 귀속을 service-only 불변 원장으로 기록한다.
-- -----------------------------------------------------------------------------
-- 선행(먼저 적용): 2026-08-apply-public-rate-limit.sql,
--                  2026-08-apply-submission-recovery-ledger.sql,
--                  2026-08-tally-fallback-marketing-consent.sql
--
-- 공개 URL에는 추측 불가능한 tracking_ref만 노출한다. 실제 공고·캠페인·채널은
-- 서버 RPC가 활성 링크에서 해석하며, 제출 replay는 링크가 보관 처리된 뒤에도 최초
-- 귀속을 그대로 반환한다. raw source/job은 운영 호환을 위해 저장하되 verified_link로
-- 승격하지 않는다. 후보 연결 결과는 별도 RPC로 한 번만 확정한다.

create table if not exists public.acquisition_campaigns (
  id uuid primary key default gen_random_uuid(),
  job_id bigint not null references public.jobs(id) on delete restrict,
  source text not null
    check (source ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name text not null
    check (btrim(name) <> '' and length(name) <= 120),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint acquisition_campaigns_identity_key unique (id, job_id, source)
);

create unique index if not exists acquisition_campaigns_active_identity_uidx
  on public.acquisition_campaigns (job_id, source, name)
  where archived_at is null;

create table if not exists public.acquisition_tracking_links (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null
    references public.acquisition_campaigns(id) on delete restrict,
  tracking_ref uuid not null default gen_random_uuid(),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint acquisition_tracking_links_tracking_ref_key unique (tracking_ref),
  constraint acquisition_tracking_links_identity_key
    unique (id, campaign_id, tracking_ref)
);

create unique index if not exists acquisition_tracking_links_active_campaign_uidx
  on public.acquisition_tracking_links (campaign_id)
  where archived_at is null;

create table if not exists public.application_submission_attributions (
  submission_id uuid primary key,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  attribution_method text not null
    check (attribution_method in (
      'verified_link',
      'signed_internal',
      'legacy_declared',
      'direct',
      'invalid_ref'
    )),
  source text not null
    check (btrim(source) <> '' and length(source) <= 64),
  job_id bigint references public.jobs(id) on delete restrict,
  campaign_id uuid,
  link_id uuid,
  tracking_ref uuid,
  created_at timestamptz not null default now(),
  constraint application_submission_attributions_submission_fingerprint_key
    unique (submission_id, request_fingerprint),
  constraint application_submission_attributions_verified_context_check check (
    (
      attribution_method = 'verified_link'
      and job_id is not null
      and campaign_id is not null
      and link_id is not null
      and tracking_ref is not null
    )
    or
    (
      attribution_method <> 'verified_link'
      and campaign_id is null
      and link_id is null
      and tracking_ref is null
    )
  ),
  constraint application_submission_attributions_campaign_context_fkey
    foreign key (campaign_id, job_id, source)
    references public.acquisition_campaigns(id, job_id, source)
    on delete restrict,
  constraint application_submission_attributions_link_context_fkey
    foreign key (link_id, campaign_id, tracking_ref)
    references public.acquisition_tracking_links(id, campaign_id, tracking_ref)
    on delete restrict
);

create index if not exists application_submission_attributions_job_created_idx
  on public.application_submission_attributions (job_id, created_at desc);
create index if not exists application_submission_attributions_source_created_idx
  on public.application_submission_attributions (source, created_at desc);

create table if not exists public.application_submission_attribution_outcomes (
  submission_id uuid primary key,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  applicant_id bigint references public.applicants(id) on delete set null,
  candidate_link_outcome text not null
    check (candidate_link_outcome in (
      'linked',
      'already_linked',
      'unchanged_closed',
      'unavailable',
      'failed',
      'not_requested'
    )),
  finalized_at timestamptz not null default now(),
  constraint application_submission_attribution_outcomes_attribution_fkey
    foreign key (submission_id, request_fingerprint)
    references public.application_submission_attributions(submission_id, request_fingerprint)
    on delete restrict
);

comment on table public.acquisition_campaigns is
  '공고별 외부 모집 채널 캠페인. 삭제 대신 archived_at으로 보관한다.';
comment on table public.acquisition_tracking_links is
  '공개 지원 URL에 사용하는 opaque UUID. 캠페인 삭제는 RESTRICT하고 archived_at으로 비활성화한다.';
comment on table public.application_submission_attributions is
  '제출 UUID별 최초 유입 귀속 불변 원장. 공개 선언값은 verified_link가 될 수 없다.';
comment on table public.application_submission_attribution_outcomes is
  '귀속된 제출의 최종 후보 연결 결과. finalize RPC로만 최초 기록한다.';

alter table public.acquisition_campaigns enable row level security;
alter table public.acquisition_tracking_links enable row level security;
alter table public.application_submission_attributions enable row level security;
alter table public.application_submission_attribution_outcomes enable row level security;

revoke all on table public.acquisition_campaigns from public;
revoke all on table public.acquisition_campaigns from anon, authenticated;
grant select, insert on table public.acquisition_campaigns to service_role;
grant update (archived_at) on table public.acquisition_campaigns to service_role;

revoke all on table public.acquisition_tracking_links from public;
revoke all on table public.acquisition_tracking_links from anon, authenticated;
grant select, insert on table public.acquisition_tracking_links to service_role;
grant update (archived_at) on table public.acquisition_tracking_links to service_role;

revoke all on table public.application_submission_attributions from public;
revoke all on table public.application_submission_attributions from anon, authenticated;
grant select on table public.application_submission_attributions to service_role;

revoke all on table public.application_submission_attribution_outcomes from public;
revoke all on table public.application_submission_attribution_outcomes from anon, authenticated;
grant select on table public.application_submission_attribution_outcomes to service_role;

create or replace function public.reject_application_submission_attribution_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'application submission attribution is immutable'
    using errcode = '55000';
end;
$$;

drop trigger if exists application_submission_attributions_reject_mutation
  on public.application_submission_attributions;
create trigger application_submission_attributions_reject_mutation
before update or delete on public.application_submission_attributions
for each row
execute function public.reject_application_submission_attribution_mutation();

revoke all on function public.reject_application_submission_attribution_mutation()
  from public;
revoke execute on function public.reject_application_submission_attribution_mutation()
  from anon, authenticated, service_role;

create or replace function public.get_or_create_acquisition_tracking_link(
  p_job_id bigint,
  p_source text,
  p_name text
)
returns table (
  link_id uuid,
  tracking_ref uuid,
  campaign_id uuid,
  job_id bigint,
  source text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source text := lower(btrim(coalesce(p_source, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_campaign_id uuid;
  v_link_id uuid;
  v_tracking_ref uuid;
begin
  if p_job_id is null or p_job_id <= 0 then
    raise exception 'acquisition campaign job is invalid'
      using errcode = '22023';
  end if;
  if v_source not in ('facebook', 'albamon', 'jobkorea', 'openchat', 'referral', 'direct') then
    raise exception 'acquisition campaign source is invalid'
      using errcode = '22023';
  end if;
  if v_name = '' or length(v_name) > 120 then
    raise exception 'acquisition campaign name is invalid'
      using errcode = '22023';
  end if;

  perform 1
  from public.jobs as job
  where job.id = p_job_id
  for key share;
  if not found then
    raise exception 'acquisition campaign job does not exist'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'acquisition-link:' || p_job_id::text || ':' || v_source || ':' || v_name,
    0
  ));

  select campaign.id
  into v_campaign_id
  from public.acquisition_campaigns as campaign
  where campaign.job_id = p_job_id
    and campaign.source = v_source
    and campaign.name = v_name
    and campaign.archived_at is null
  order by campaign.created_at, campaign.id
  limit 1
  for update;

  if v_campaign_id is null then
    insert into public.acquisition_campaigns (job_id, source, name)
    values (p_job_id, v_source, v_name)
    returning id into v_campaign_id;
  end if;

  select link.id, link.tracking_ref
  into v_link_id, v_tracking_ref
  from public.acquisition_tracking_links as link
  where link.campaign_id = v_campaign_id
    and link.archived_at is null
  order by link.created_at, link.id
  limit 1
  for update;

  if v_link_id is null then
    insert into public.acquisition_tracking_links (campaign_id)
    values (v_campaign_id)
    returning id, acquisition_tracking_links.tracking_ref
      into v_link_id, v_tracking_ref;
  end if;

  return query select
    v_link_id,
    v_tracking_ref,
    v_campaign_id,
    p_job_id,
    v_source;
end;
$$;

revoke all on function public.get_or_create_acquisition_tracking_link(bigint, text, text)
  from public;
revoke execute on function public.get_or_create_acquisition_tracking_link(bigint, text, text)
  from anon, authenticated;
grant execute on function public.get_or_create_acquisition_tracking_link(bigint, text, text)
  to service_role;

create or replace function public.claim_application_submission_with_attribution(
  p_submission_id uuid,
  p_request_fingerprint text,
  p_phone_hash text,
  p_ip_hash text,
  p_trusted_internal boolean,
  p_tracking_ref text,
  p_declared_source text,
  p_declared_job_id bigint
)
returns table (
  outcome text,
  retry_after_seconds integer,
  canonical_method text,
  canonical_source text,
  canonical_job_id bigint,
  canonical_campaign_id uuid,
  canonical_link_id uuid,
  tracking_ref uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tracking_ref_text text := nullif(btrim(coalesce(p_tracking_ref, '')), '');
  v_declared_source text := lower(btrim(coalesce(p_declared_source, '')));
  v_parsed_tracking_ref uuid;
  v_verified_link_id uuid;
  v_verified_tracking_ref uuid;
  v_verified_campaign_id uuid;
  v_verified_job_id bigint;
  v_verified_source text;
  v_has_verified_link boolean := false;
  v_admission_outcome text;
  v_retry_after_seconds integer;
  v_effective_trusted_internal boolean;
  v_attribution_method text;
  v_canonical_source text;
  v_canonical_job_id bigint;
  v_canonical_campaign_id uuid;
  v_canonical_link_id uuid;
  v_canonical_tracking_ref uuid;
  v_attribution public.application_submission_attributions%rowtype;
begin
  if p_declared_job_id is not null and p_declared_job_id <= 0 then
    raise exception 'declared acquisition job is invalid'
      using errcode = '22023';
  end if;

  if v_declared_source not in (
    'danggeun',
    'baemin',
    'facebook',
    'naver',
    'homepage',
    'albamon',
    'jobkorea',
    'openchat',
    'referral',
    'direct'
  ) then
    v_declared_source := 'direct';
  end if;

  if v_tracking_ref_text is not null
    and v_tracking_ref_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_parsed_tracking_ref := v_tracking_ref_text::uuid;

    select
      link.id,
      link.tracking_ref,
      campaign.id,
      campaign.job_id,
      campaign.source
    into
      v_verified_link_id,
      v_verified_tracking_ref,
      v_verified_campaign_id,
      v_verified_job_id,
      v_verified_source
    from public.acquisition_tracking_links as link
    join public.acquisition_campaigns as campaign
      on campaign.id = link.campaign_id
    where link.tracking_ref = v_parsed_tracking_ref
      and link.archived_at is null
      and campaign.archived_at is null
    for share of link, campaign;

    v_has_verified_link := found;
  end if;

  select admission.outcome, admission.retry_after_seconds
  into v_admission_outcome, v_retry_after_seconds
  from public.claim_application_submission_admission(
    p_submission_id,
    p_request_fingerprint,
    p_phone_hash,
    p_ip_hash,
    p_trusted_internal
  ) as admission;

  if v_admission_outcome in ('conflict', 'rate_limited') then
    return query select
      v_admission_outcome,
      coalesce(v_retry_after_seconds, 0),
      null::text,
      null::text,
      null::bigint,
      null::uuid,
      null::uuid,
      null::uuid;
    return;
  end if;

  if v_admission_outcome not in ('admitted', 'replay') then
    return query select
      'error'::text,
      0,
      null::text,
      null::text,
      null::bigint,
      null::uuid,
      null::uuid,
      null::uuid;
    return;
  end if;

  if v_admission_outcome = 'replay' then
    select attribution.*
    into v_attribution
    from public.application_submission_attributions as attribution
    where attribution.submission_id = p_submission_id;

    if found then
      if v_attribution.request_fingerprint is distinct from p_request_fingerprint then
        return query select
          'conflict'::text,
          0,
          null::text,
          null::text,
          null::bigint,
          null::uuid,
          null::uuid,
          null::uuid;
        return;
      end if;

      return query select
        'replay'::text,
        0,
        v_attribution.attribution_method,
        v_attribution.source,
        v_attribution.job_id,
        v_attribution.campaign_id,
        v_attribution.link_id,
        v_attribution.tracking_ref;
      return;
    end if;

    -- 이 마이그레이션 이전 admission replay는 현재 ref로 소급 검증하지 않는다.
    select admission.trusted_internal
    into v_effective_trusted_internal
    from public.application_submission_admissions as admission
    where admission.submission_id = p_submission_id;
    v_has_verified_link := false;
  else
    v_effective_trusted_internal := p_trusted_internal;

    if v_has_verified_link
      and p_declared_job_id is not null
      and p_declared_job_id is distinct from v_verified_job_id then
      -- admission 함수가 방금 만든 행만 되돌려 다음 올바른 요청을 막지 않는다.
      delete from public.application_submission_admissions
      where submission_id = p_submission_id;

      return query select
        'context_mismatch'::text,
        0,
        null::text,
        null::text,
        null::bigint,
        null::uuid,
        null::uuid,
        null::uuid;
      return;
    end if;
  end if;

  if v_has_verified_link then
    v_attribution_method := 'verified_link';
    v_canonical_source := v_verified_source;
    v_canonical_job_id := v_verified_job_id;
    v_canonical_campaign_id := v_verified_campaign_id;
    v_canonical_link_id := v_verified_link_id;
    v_canonical_tracking_ref := v_verified_tracking_ref;
  elsif v_effective_trusted_internal then
    v_attribution_method := 'signed_internal';
    v_canonical_source := v_declared_source;
    v_canonical_job_id := p_declared_job_id;
  elsif v_tracking_ref_text is not null then
    v_attribution_method := 'invalid_ref';
    v_canonical_source := v_declared_source;
    v_canonical_job_id := p_declared_job_id;
  elsif v_declared_source <> 'direct' then
    v_attribution_method := 'legacy_declared';
    v_canonical_source := v_declared_source;
    v_canonical_job_id := p_declared_job_id;
  else
    v_attribution_method := 'direct';
    v_canonical_source := 'direct';
    v_canonical_job_id := p_declared_job_id;
  end if;

  insert into public.application_submission_attributions (
    submission_id,
    request_fingerprint,
    attribution_method,
    source,
    job_id,
    campaign_id,
    link_id,
    tracking_ref
  ) values (
    p_submission_id,
    p_request_fingerprint,
    v_attribution_method,
    v_canonical_source,
    v_canonical_job_id,
    v_canonical_campaign_id,
    v_canonical_link_id,
    v_canonical_tracking_ref
  )
  on conflict (submission_id) do nothing;

  select attribution.*
  into v_attribution
  from public.application_submission_attributions as attribution
  where attribution.submission_id = p_submission_id;

  if not found
    or v_attribution.request_fingerprint is distinct from p_request_fingerprint then
    if v_admission_outcome = 'admitted' then
      delete from public.application_submission_admissions
      where submission_id = p_submission_id;
    end if;

    return query select
      'conflict'::text,
      0,
      null::text,
      null::text,
      null::bigint,
      null::uuid,
      null::uuid,
      null::uuid;
    return;
  end if;

  return query select
    v_admission_outcome,
    coalesce(v_retry_after_seconds, 0),
    v_attribution.attribution_method,
    v_attribution.source,
    v_attribution.job_id,
    v_attribution.campaign_id,
    v_attribution.link_id,
    v_attribution.tracking_ref;
end;
$$;

revoke all on function public.claim_application_submission_with_attribution(
  uuid, text, text, text, boolean, text, text, bigint
) from public;
revoke execute on function public.claim_application_submission_with_attribution(
  uuid, text, text, text, boolean, text, text, bigint
) from anon, authenticated;
grant execute on function public.claim_application_submission_with_attribution(
  uuid, text, text, text, boolean, text, text, bigint
) to service_role;

create or replace function public.finalize_application_submission_attribution(
  p_submission_id uuid,
  p_request_fingerprint text,
  p_applicant_id bigint,
  p_candidate_link_outcome text
)
returns table (
  outcome text,
  request_fingerprint text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attribution_fingerprint text;
  v_existing public.application_submission_attribution_outcomes%rowtype;
begin
  if p_submission_id is null
    or p_request_fingerprint is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_applicant_id is null
    or p_applicant_id <= 0
    or p_candidate_link_outcome not in (
      'linked',
      'already_linked',
      'unchanged_closed',
      'unavailable',
      'failed',
      'not_requested'
    ) then
    raise exception 'invalid attribution finalization input'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('apply:submission:' || p_submission_id::text, 0)
  );

  select attribution.request_fingerprint
  into v_attribution_fingerprint
  from public.application_submission_attributions as attribution
  where attribution.submission_id = p_submission_id;

  if not found then
    return query select 'missing'::text, null::text;
    return;
  end if;

  if v_attribution_fingerprint is distinct from p_request_fingerprint then
    return query select 'conflict'::text, v_attribution_fingerprint;
    return;
  end if;

  insert into public.application_submission_attribution_outcomes (
    submission_id,
    request_fingerprint,
    applicant_id,
    candidate_link_outcome
  ) values (
    p_submission_id,
    p_request_fingerprint,
    p_applicant_id,
    p_candidate_link_outcome
  )
  on conflict (submission_id) do nothing
  returning * into v_existing;

  if found then
    return query select 'recorded'::text, v_existing.request_fingerprint;
    return;
  end if;

  select finalized.*
  into v_existing
  from public.application_submission_attribution_outcomes as finalized
  where finalized.submission_id = p_submission_id;

  if v_existing.request_fingerprint is not distinct from p_request_fingerprint
    and v_existing.applicant_id is not distinct from p_applicant_id
    and v_existing.candidate_link_outcome is not distinct from p_candidate_link_outcome then
    return query select 'replay'::text, v_existing.request_fingerprint;
  else
    return query select 'conflict'::text, v_existing.request_fingerprint;
  end if;
end;
$$;

revoke all on function public.finalize_application_submission_attribution(uuid, text, bigint, text)
  from public;
revoke execute on function public.finalize_application_submission_attribution(uuid, text, bigint, text)
  from anon, authenticated;
grant execute on function public.finalize_application_submission_attribution(uuid, text, bigint, text)
  to service_role;

create or replace view public.application_submission_attribution_performance as
select
  attribution.submission_id,
  attribution.source,
  attribution.attribution_method,
  finalized.candidate_link_outcome,
  finalized.applicant_id,
  attribution.job_id,
  attribution.campaign_id,
  attribution.link_id,
  attribution.tracking_ref,
  attribution.created_at as submitted_at,
  finalized.finalized_at
from public.application_submission_attributions as attribution
left join public.application_submission_attribution_outcomes as finalized
  on finalized.submission_id = attribution.submission_id
 and finalized.request_fingerprint = attribution.request_fingerprint;

revoke all on table public.application_submission_attribution_performance from public;
revoke all on table public.application_submission_attribution_performance from anon, authenticated;
grant select on table public.application_submission_attribution_performance to service_role;

-- 최신 Tally 폴백 동작을 유지하면서 homepage 귀속과 not_requested 결과도 같은
-- 트랜잭션에 기록한다. 기존 submission replay는 원장 보강 뒤 마케팅 동의 갱신 전에
-- 반환하므로 이후 수신거부를 되돌리지 않는다.
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
  v_replay boolean := false;
  v_phone text;
  v_attribution public.application_submission_attributions%rowtype;
  v_finalize_outcome text;
  v_finalize_fingerprint text;
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
    v_applicant_id := v_existing_applicant_id;
    v_replay := true;
  else
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
  end if;

  insert into public.application_submission_attributions (
    submission_id,
    request_fingerprint,
    attribution_method,
    source,
    job_id,
    campaign_id,
    link_id,
    tracking_ref
  ) values (
    p_submission_id,
    p_request_fingerprint,
    'signed_internal',
    'homepage',
    null,
    null,
    null,
    null
  )
  on conflict (submission_id) do nothing;

  select attribution.*
  into v_attribution
  from public.application_submission_attributions as attribution
  where attribution.submission_id = p_submission_id;

  if not found
    or v_attribution.request_fingerprint is distinct from p_request_fingerprint
    or v_attribution.attribution_method is distinct from 'signed_internal'
    or v_attribution.source is distinct from 'homepage'
    or v_attribution.job_id is not null
    or v_attribution.campaign_id is not null
    or v_attribution.link_id is not null
    or v_attribution.tracking_ref is not null then
    raise exception 'Tally submission attribution conflicts with stored context'
      using errcode = '23505';
  end if;

  select finalized.outcome, finalized.request_fingerprint
  into v_finalize_outcome, v_finalize_fingerprint
  from public.finalize_application_submission_attribution(
    p_submission_id,
    p_request_fingerprint,
    v_applicant_id,
    'not_requested'
  ) as finalized;

  if v_finalize_outcome not in ('recorded', 'replay')
    or v_finalize_fingerprint is distinct from p_request_fingerprint then
    raise exception 'Tally submission attribution outcome conflicts with stored result'
      using errcode = '23505';
  end if;

  if v_replay then
    return query select v_applicant_id, false;
    return;
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

revoke all on function public.claim_tally_fallback_submission(uuid, text, jsonb)
  from public;
revoke execute on function public.claim_tally_fallback_submission(uuid, text, jsonb)
  from anon, authenticated;
grant execute on function public.claim_tally_fallback_submission(uuid, text, jsonb)
  to service_role;

comment on function public.claim_tally_fallback_submission(uuid, text, jsonb)
  is 'Tally 폴백을 제출·귀속·결과 원장에 멱등 기록하고 신규 명시 문자 동의를 최종 지원자에 원자 저장한다.';
