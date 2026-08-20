-- 지원서 UUID를 applicant 행에도 원자적으로 보존한다.
-- applicant 저장 뒤 첫 메시지 outbox 선점 전에 함수가 중단되어도, 같은 key 재시도는
-- 전화번호·현재 상태로 새 행을 고르지 않고 원래 applicant_id를 다시 찾는다.

alter table public.applicants
  add column if not exists application_submission_id uuid;

alter table public.applicants
  add column if not exists application_request_fingerprint text;

alter table public.applicants
  add column if not exists application_auto_engagement_required boolean not null default false;

create unique index if not exists applicants_application_submission_id_uidx
  on public.applicants (application_submission_id)
  where application_submission_id is not null;

comment on column public.applicants.application_submission_id is
  '가장 최근 웹 지원 payload의 caller UUID. outbox 선점 전 중단된 동일 제출을 같은 applicant 행으로 복구한다.';
comment on column public.applicants.application_request_fingerprint is
  'application_submission_id와 결합된 전체 지원 payload SHA-256 지문.';
comment on column public.applicants.application_auto_engagement_required is
  '해당 submission이 신규/진짜 배민 placeholder 완성으로서 첫 안내·시스템 후보 보장을 필요로 했는지 여부.';

alter table public.application_message_send_requests
  add column if not exists auto_engagement_required boolean not null default true;

comment on column public.application_message_send_requests.auto_engagement_required is
  '첫 안내 outbox를 만든 submission의 자동 응대 보장 여부. replay에서 시스템 후보를 중복 없이 복구할 때 사용한다.';
