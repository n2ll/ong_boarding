-- 공개 지원서 첫 안내 메시지의 응답 유실·재시도 중복 발송을 막는다.
-- 브라우저가 제출 payload마다 만든 UUID를 service-role 전용 outbox에서 먼저 선점한 뒤
-- 외부 발송을 호출한다. 어떤 기존 상태도 공급자를 다시 호출하지 않는다.
--
-- 상태 계약:
--   sending  : 한 요청이 선점함. 결과가 불명확할 수 있어 replay 발송 금지.
--   unknown  : 공급자 호출 예외. 결과가 불명확하므로 replay 발송 금지.
--   failed   : 공급자가 실패를 확정. 같은 제출 key로 replay 발송 금지.
--   sent     : 공급자 성공을 먼저 보존. messages 기록 실패 시 replay가 기록만 복구.
--   recorded : 실제 messages 행까지 기록됨. unique key로 중복 기록 방지.

create table if not exists public.application_message_send_requests (
  idempotency_key uuid primary key,
  request_fingerprint text not null,
  applicant_id bigint not null,
  applicant_phone text not null,
  body text not null,
  job_id bigint,
  sent_by text not null,
  message_kind text not null
    check (message_kind in ('start', 'receipt')),
  status text not null default 'sending'
    check (status in ('sending', 'unknown', 'failed', 'sent', 'recorded')),
  provider_message_id text,
  message_type text,
  template_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  recorded_at timestamptz
);

comment on table public.application_message_send_requests is
  '지원서 첫 안내 발송 outbox. service role만 접근하며 외부 발송 성공 전 messages 트리거를 발생시키지 않는다.';
comment on column public.application_message_send_requests.idempotency_key is
  '브라우저가 동일 지원서 payload의 재시도에 재사용하는 UUID.';
comment on column public.application_message_send_requests.request_fingerprint is
  'UUID를 다른 지원서 payload에 재사용하는 충돌을 fail-closed로 거부하기 위한 전체 payload 지문.';

alter table public.application_message_send_requests enable row level security;
revoke all on table public.application_message_send_requests from public;
revoke all on table public.application_message_send_requests from anon, authenticated;
grant select, insert, update on table public.application_message_send_requests to service_role;

alter table public.messages
  add column if not exists client_request_id uuid;

create unique index if not exists messages_client_request_id_uidx
  on public.messages (client_request_id)
  where client_request_id is not null;

comment on column public.messages.client_request_id is
  '브라우저 발송·지원 제출 요청 UUID. 공급자 성공 뒤 messages 기록을 복구할 때 중복 행을 막는다.';
