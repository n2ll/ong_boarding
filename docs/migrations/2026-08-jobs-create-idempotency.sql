-- P0: 매니저 공고 생성의 응답 유실·더블클릭·네트워크 재시도 중복 행을 막는다.
-- -----------------------------------------------------------------------------
-- 브라우저가 생성 의도마다 만든 UUID와 요청 payload의 SHA-256을 공고 행에 함께 보존한다.
-- 같은 UUID의 동시 INSERT는 unique index가 직렬화하며, API는 기존 행의 fingerprint를 비교해
-- 같은 payload면 기존 공고를 반환하고 다른 payload면 409로 fail-closed한다.
--
-- 기존 공고는 두 컬럼이 모두 NULL인 채 유지한다. 새 API 요청만 두 값을 함께 기록한다.
-- 멱등: 컬럼·인덱스는 IF NOT EXISTS, check constraint는 같은 정의로 재생성한다.

alter table public.jobs
  add column if not exists client_request_id uuid;

alter table public.jobs
  add column if not exists creation_request_fingerprint text;

create unique index if not exists jobs_client_request_id_uidx
  on public.jobs (client_request_id)
  where client_request_id is not null;

alter table public.jobs
  drop constraint if exists jobs_creation_request_pair_check;

alter table public.jobs
  add constraint jobs_creation_request_pair_check
  check (
    (client_request_id is null and creation_request_fingerprint is null)
    or (
      client_request_id is not null
      and creation_request_fingerprint ~ '^[0-9a-f]{64}$'
    )
  );

comment on column public.jobs.client_request_id is
  '브라우저가 공고 생성 의도마다 만든 UUID. 동일 key replay는 새 공고를 만들지 않는다.';

comment on column public.jobs.creation_request_fingerprint is
  'client_request_id를 제외한 canonical 생성 payload의 SHA-256. 같은 key의 다른 payload를 409로 거부한다.';
