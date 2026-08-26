-- 이전 jobs 생성 멱등성 migration의 CHECK는 PostgreSQL NULL 3-valued logic 때문에
-- request id만 있고 fingerprint가 NULL인 행을 거부하지 못했다. 이미 적용된 migration은
-- 수정하지 않고 누적 migration으로 두 값을 반드시 한 쌍으로 저장하도록 보정한다.
-- 파일명은 원본(2026-08-jobs-create-idempotency.sql)보다 뒤에 정렬되게 두었다.

begin;

do $$
begin
  if exists (
    select 1
    from public.jobs
    where (client_request_id is null) <> (creation_request_fingerprint is null)
       or (
         creation_request_fingerprint is not null
         and creation_request_fingerprint !~ '^[0-9a-f]{64}$'
       )
  ) then
    raise exception 'jobs contains an invalid client_request_id/fingerprint pair';
  end if;
end
$$;

alter table public.jobs
  drop constraint if exists jobs_creation_request_pair_check;

alter table public.jobs
  add constraint jobs_creation_request_pair_check
  check (
    (client_request_id is null and creation_request_fingerprint is null)
    or (
      client_request_id is not null
      and creation_request_fingerprint is not null
      and creation_request_fingerprint ~ '^[0-9a-f]{64}$'
    )
  );

commit;
