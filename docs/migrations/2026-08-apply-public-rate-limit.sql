-- 공개 지원 API의 durable admission + SMS abuse 방어
-- ------------------------------------------------------------
-- 선행(먼저 적용): 2026-08-apply-submission-recovery-ledger.sql
--
-- 같은 submission UUID replay는 영구 허용하되 payload 충돌은 거부한다.
-- 새 submission은 전화번호별 10분 cooldown과 direct 네트워크별 10분/10건 제한을
-- applicant·지오코딩·외부 메시지 작업 전에 원자적으로 통과해야 한다.
-- 전화번호/IP 원문은 저장하지 않고 서버 HMAC만 저장한다.

create table if not exists public.application_submission_admissions (
  submission_id uuid primary key,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  phone_hash text not null
    check (phone_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text not null
    check (ip_hash ~ '^[0-9a-f]{64}$'),
  trusted_internal boolean not null default false,
  admitted_at timestamptz not null default now()
);

create index if not exists application_submission_admissions_phone_recent_idx
  on public.application_submission_admissions (phone_hash, admitted_at desc);
create index if not exists application_submission_admissions_ip_recent_idx
  on public.application_submission_admissions (ip_hash, admitted_at desc)
  where trusted_internal = false;

comment on table public.application_submission_admissions is
  '공개 지원 제출의 service-only admission 원장. 원본 전화번호/IP 대신 서버 HMAC만 저장한다.';
comment on column public.application_submission_admissions.trusted_internal is
  '서명 검증된 Tally canonical 호출. 공유 서버 IP 제한만 제외하며 전화번호 cooldown은 동일 적용한다.';

alter table public.application_submission_admissions enable row level security;
revoke all on table public.application_submission_admissions from public;
revoke all on table public.application_submission_admissions from anon, authenticated;
grant select on table public.application_submission_admissions to service_role;

create or replace function public.claim_application_submission_admission(
  p_submission_id uuid,
  p_request_fingerprint text,
  p_phone_hash text,
  p_ip_hash text,
  p_trusted_internal boolean
)
returns table (
  outcome text,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing_fingerprint text;
  v_now timestamptz := clock_timestamp();
  v_blocked_until timestamptz;
  v_ip_count integer;
begin
  if p_submission_id is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_phone_hash !~ '^[0-9a-f]{64}$'
    or p_ip_hash !~ '^[0-9a-f]{64}$'
    or p_trusted_internal is null then
    raise exception 'invalid application admission input'
      using errcode = '22023';
  end if;

  -- 모든 호출이 application submission -> phone -> IP 순서로 잠가 교착을 피한다.
  perform pg_advisory_xact_lock(
    hashtextextended('apply:submission:' || p_submission_id::text, 0)
  );

  select request_fingerprint
  into v_existing_fingerprint
  from public.application_submission_admissions
  where submission_id = p_submission_id;

  if found then
    if v_existing_fingerprint is distinct from p_request_fingerprint then
      return query select 'conflict'::text, 0;
    else
      return query select 'replay'::text, 0;
    end if;
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('apply:phone:' || p_phone_hash, 0)
  );

  select max(admitted_at + interval '10 minutes')
  into v_blocked_until
  from public.application_submission_admissions
  where phone_hash = p_phone_hash
    and admitted_at > v_now - interval '10 minutes';

  if v_blocked_until is not null and v_blocked_until > v_now then
    return query select
      'rate_limited'::text,
      greatest(1, ceil(extract(epoch from (v_blocked_until - v_now)))::integer);
    return;
  end if;

  if not p_trusted_internal then
    perform pg_advisory_xact_lock(
      hashtextextended('apply:ip:' || p_ip_hash, 0)
    );

    select
      count(*)::integer,
      min(admitted_at) + interval '10 minutes'
    into v_ip_count, v_blocked_until
    from public.application_submission_admissions
    where ip_hash = p_ip_hash
      and trusted_internal = false
      and admitted_at > v_now - interval '10 minutes';

    if v_ip_count >= 10 then
      return query select
        'rate_limited'::text,
        greatest(1, ceil(extract(epoch from (v_blocked_until - v_now)))::integer);
      return;
    end if;
  end if;

  insert into public.application_submission_admissions (
    submission_id,
    request_fingerprint,
    phone_hash,
    ip_hash,
    trusted_internal,
    admitted_at
  ) values (
    p_submission_id,
    p_request_fingerprint,
    p_phone_hash,
    p_ip_hash,
    p_trusted_internal,
    v_now
  );

  return query select 'admitted'::text, 0;
end;
$$;

revoke all on function public.claim_application_submission_admission(uuid, text, text, text, boolean)
  from public;
revoke execute on function public.claim_application_submission_admission(uuid, text, text, text, boolean)
  from anon, authenticated;
grant execute on function public.claim_application_submission_admission(uuid, text, text, text, boolean)
  to service_role;
