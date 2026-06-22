-- PII 보호 — public 스키마 전면 잠금(RLS + 뷰 권한 회수)
-- ----------------------------------------------------------------
-- 배경: 현재 공개 anon 키로 applicants(이름·전화번호 등 PII), messages 본문까지
--       PostgREST로 그대로 읽혔다. anon 키는 클라이언트 번들에 노출되므로 사실상 전체 공개 상태.
--
-- 방침:
--   - public의 모든 '일반 테이블' → 기존 정책 제거 후 RLS 활성화(정책 0개 = anon/authenticated 전면 차단).
--   - public의 모든 '뷰/구체화뷰' → RLS를 켤 수 없고 소유자 권한으로 실행되어 RLS를 우회할 수 있으므로,
--     anon·authenticated 권한을 명시적으로 회수(REVOKE)하여 차단.
--   - service_role(서버 API, createServiceClient)은 BYPASSRLS이고 회수 대상이 아니므로 앱 동작은 그대로.
--
-- 선행 조건(코드): 프론트에서 anon으로 DB를 직접 읽던 유일한 경로(LiveConsole의 message_drafts)를
--   서버 라우트(/api/admin/drafts/pending)로 전환 완료. 따라서 차단 후에도 기능 손실 없음.
--
-- 재실행 안전: 멱등(이미 켜져 있거나 이미 회수돼 있어도 에러 없음).

do $$
declare
  rec record;
  pol record;
begin
  for rec in
    select c.relname, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm')  -- r=table, p=partitioned, v=view, m=matview
  loop
    if rec.relkind in ('r', 'p') then
      -- 1) 기존 정책 전부 제거 — anon을 허용하던 정책이 남아 있으면 PII가 계속 새므로 모두 삭제.
      for pol in
        select policyname from pg_policies
        where schemaname = 'public' and tablename = rec.relname
      loop
        execute format('drop policy if exists %I on public.%I;', pol.policyname, rec.relname);
      end loop;

      -- 2) RLS 활성화. 정책이 하나도 없으므로 anon/authenticated는 전면 차단,
      --    service_role(BYPASSRLS)인 서버 API는 그대로 동작.
      execute format('alter table public.%I enable row level security;', rec.relname);
    else
      -- 뷰/구체화뷰: RLS 불가 → 공개 역할의 접근 권한 회수.
      execute format('revoke all on public.%I from anon, authenticated;', rec.relname);
    end if;
  end loop;
end $$;
