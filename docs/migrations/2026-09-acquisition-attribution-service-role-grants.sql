-- 지원 유입 귀속 원장의 service_role 권한을 필요한 연산으로 제한한다.
-- -----------------------------------------------------------------------------
-- Supabase의 기본 권한으로 service_role에 새 relation의 전체 권한이 남을 수 있다.
-- 기존 귀속 migration은 service_role 권한을 먼저 회수하지 않아 column-only UPDATE보다
-- 넓은 UPDATE/DELETE/TRUNCATE 권한이 유지됐다. 전체 권한을 회수한 뒤 필요한 권한만
-- 다시 부여한다. 반복 실행해도 같은 권한 상태로 수렴한다.

revoke all on table public.acquisition_campaigns from service_role;
grant select, insert on table public.acquisition_campaigns to service_role;
grant update (archived_at) on table public.acquisition_campaigns to service_role;

revoke all on table public.acquisition_tracking_links from service_role;
grant select, insert on table public.acquisition_tracking_links to service_role;
grant update (archived_at) on table public.acquisition_tracking_links to service_role;

revoke all on table public.application_submission_attributions from service_role;
grant select on table public.application_submission_attributions to service_role;

revoke all on table public.application_submission_attribution_outcomes from service_role;
grant select on table public.application_submission_attribution_outcomes to service_role;

revoke all on table public.application_submission_attribution_performance from service_role;
grant select on table public.application_submission_attribution_performance to service_role;
