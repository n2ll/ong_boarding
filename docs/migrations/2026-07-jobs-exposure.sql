-- 2026-07-jobs-exposure.sql
-- J · 타겟 공고 노출 — 공고를 특정 인력에게만 노출(지정 노출). 기본은 '전체 노출'(기존 동작 불변).
-- 배정 = 규칙(자동, exposure_rule) + 수동(job_exposure_targets include/exclude) 둘 다.
-- 유효 노출: exclude 있으면 제외 → include 있으면 노출 → 규칙 매칭이면 노출 → 아니면 제외.

alter table jobs add column if not exists exposure text not null default 'all';
alter table jobs drop constraint if exists jobs_exposure_check;
alter table jobs add constraint jobs_exposure_check check (exposure in ('all','targeted'));

-- 자동 노출 규칙(파이프라인 필터 스키마 재사용). null이면 규칙 없음(수동만).
alter table jobs add column if not exists exposure_rule jsonb;

-- 수동 오버라이드 — include(명시 추가)/exclude(명시 제외, 규칙·include보다 우선).
create table if not exists job_exposure_targets (
  id uuid primary key default gen_random_uuid(),
  job_id bigint not null references jobs(id) on delete cascade,
  applicant_id bigint not null references applicants(id) on delete cascade,
  mode text not null default 'include' check (mode in ('include','exclude')),
  added_by text,
  created_at timestamptz not null default now(),
  unique (job_id, applicant_id)
);
create index if not exists idx_jet_job on job_exposure_targets (job_id);
create index if not exists idx_jet_applicant on job_exposure_targets (applicant_id);

-- 서버(service_role) 전용 — anon/authenticated 차단(rls-lockdown posture).
alter table job_exposure_targets enable row level security;

comment on column jobs.exposure is 'all=전체 노출(기본)/targeted=지정 노출. pull 페이지 노출 게이팅.';
comment on column jobs.exposure_rule is '지정 노출 자동 조건(jsonb, 파이프라인 필터 스키마). null=규칙 없음.';
comment on table job_exposure_targets is '지정 노출 수동 오버라이드. mode=include(추가)/exclude(제외·최우선). unique(job_id,applicant_id).';
