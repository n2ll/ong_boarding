-- 지원 제출 UUID 누적 원장
-- ------------------------------------------------------------
-- 선행(먼저 적용): 2026-08-apply-message-idempotency.sql,
--                   2026-08-apply-submission-mapping.sql
--
-- applicants의 application_submission_id는 최신 제출만 가리킬 수 있다. 이 누적 원장은
-- 모든 제출 UUID를 최초 applicant_id에 영구 매핑한다. applicants INSERT/UPDATE와 같은
-- 트랜잭션의 AFTER trigger에서 기록하므로, applicant 저장 직후 API가 중단되어 첫 메시지
-- outbox를 만들지 못해도 동일 UUID 재시도는 원래 applicant를 찾는다.

create table if not exists public.application_submission_mappings (
  submission_id uuid primary key,
  request_fingerprint text not null,
  applicant_id bigint not null references public.applicants(id) on delete cascade,
  auto_engagement_required boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists application_submission_mappings_applicant_id_idx
  on public.application_submission_mappings (applicant_id);

comment on table public.application_submission_mappings is
  '지원 제출 UUID의 누적 원장. 같은 UUID는 최초 payload와 applicant에만 결합된다.';
comment on column public.application_submission_mappings.request_fingerprint is
  '지원 payload SHA-256. 같은 UUID를 변경된 payload에 재사용하면 fail-closed 처리한다.';
comment on column public.application_submission_mappings.auto_engagement_required is
  '중단 복구 시 첫 안내 outbox와 시스템 후보를 보장해야 하는 최초 처리 여부.';

alter table public.application_submission_mappings enable row level security;
revoke all on table public.application_submission_mappings from public;
revoke all on table public.application_submission_mappings from anon, authenticated;
grant select, insert on table public.application_submission_mappings to service_role;

create or replace function public.capture_application_submission_mapping()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.application_submission_mappings%rowtype;
begin
  if new.application_submission_id is null then
    return new;
  end if;

  if new.application_request_fingerprint is null
    or btrim(new.application_request_fingerprint) = '' then
    raise exception 'application submission fingerprint is required'
      using errcode = '23502';
  end if;

  insert into public.application_submission_mappings (
    submission_id,
    request_fingerprint,
    applicant_id,
    auto_engagement_required
  ) values (
    new.application_submission_id,
    new.application_request_fingerprint,
    new.id,
    new.application_auto_engagement_required
  )
  on conflict (submission_id) do nothing;

  if found then
    return new;
  end if;

  select *
  into v_existing
  from public.application_submission_mappings
  where submission_id = new.application_submission_id;

  if v_existing.applicant_id is distinct from new.id
    or v_existing.request_fingerprint is distinct from new.application_request_fingerprint
    or v_existing.auto_engagement_required is distinct from new.application_auto_engagement_required then
    raise exception 'application submission UUID is already mapped to another request'
      using errcode = '23505';
  end if;

  return new;
end;
$$;

drop trigger if exists applicants_capture_application_submission_mapping
  on public.applicants;
create trigger applicants_capture_application_submission_mapping
after insert or update of
  application_submission_id,
  application_request_fingerprint,
  application_auto_engagement_required
on public.applicants
for each row
when (new.application_submission_id is not null)
execute function public.capture_application_submission_mapping();

-- 첫 안내 outbox가 가진 모든 과거 submission 매핑을 먼저 누적한다.
insert into public.application_submission_mappings (
  submission_id,
  request_fingerprint,
  applicant_id,
  auto_engagement_required,
  created_at
)
select
  request.idempotency_key,
  request.request_fingerprint,
  request.applicant_id,
  request.auto_engagement_required,
  request.created_at
from public.application_message_send_requests as request
where exists (
  select 1
  from public.applicants as applicant
  where applicant.id = request.applicant_id
)
on conflict (submission_id) do nothing;

-- 선행 마이그레이션과 이번 마이그레이션 사이에 저장된 최신 applicant 매핑도 옮긴다.
insert into public.application_submission_mappings (
  submission_id,
  request_fingerprint,
  applicant_id,
  auto_engagement_required,
  created_at
)
select
  application_submission_id,
  application_request_fingerprint,
  id,
  application_auto_engagement_required,
  now()
from public.applicants
where application_submission_id is not null
  and application_request_fingerprint is not null
on conflict (submission_id) do nothing;

revoke all on function public.capture_application_submission_mapping() from public;
revoke execute on function public.capture_application_submission_mapping() from anon, authenticated;
grant execute on function public.capture_application_submission_mapping() to service_role;
