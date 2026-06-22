-- PII 보호 — 전 데이터 테이블 RLS 전면 적용(잠금)
-- ----------------------------------------------------------------
-- 배경: 현재 공개 anon 키로 applicants(이름·전화번호 등 PII), messages 본문까지
--       PostgREST로 그대로 읽혔다. anon 키는 클라이언트 번들에 노출되므로 사실상 전체 공개 상태.
--
-- 방침: 모든 데이터 테이블에 RLS를 켜되 정책을 만들지 않는다.
--   - service_role(서버 API 라우트, createServiceClient)은 RLS를 '우회'하므로 앱 동작은 그대로.
--   - anon / authenticated 역할은 정책이 없으므로 접근 전면 차단(SELECT/INSERT/UPDATE/DELETE 모두).
--
-- 선행 조건(코드): 프론트에서 anon으로 DB를 직접 읽던 유일한 경로(LiveConsole의 message_drafts)를
--   서버 라우트(/api/admin/drafts/pending)로 전환 완료. 따라서 anon 차단 후에도 기능 손실 없음.
--
-- 재실행 안전: enable row level security는 이미 켜져 있어도 에러 없이 멱등.

do $$
declare
  t text;
  pol record;
  tables text[] := array[
    'applicants',
    'messages',
    'message_drafts',
    'job_candidates',
    'jobs',
    'branches',
    'clients',
    'site_managers',
    'prompt_examples',
    'device_heartbeat',
    'usage_daily_cost',
    'legacy_applicants'
  ];
begin
  foreach t in array tables loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      -- 1) 기존 정책 전부 제거 — anon을 허용하던 정책이 남아 있으면 PII가 계속 새므로 모두 삭제.
      for pol in
        select policyname from pg_policies
        where schemaname = 'public' and tablename = t
      loop
        execute format('drop policy if exists %I on public.%I;', pol.policyname, t);
      end loop;

      -- 2) RLS 활성화. 정책이 하나도 없으므로 anon/authenticated는 전면 차단,
      --    service_role(BYPASSRLS)인 서버 API는 그대로 동작.
      execute format('alter table public.%I enable row level security;', t);
    end if;
  end loop;
end $$;
