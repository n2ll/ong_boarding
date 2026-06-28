-- 실시간 응대 콘솔 트리거 함수 하드닝 (보안 권고 대응)
-- 배경: notify_live_console()은 트리거 전용이지만 SECURITY DEFINER라
--   /rest/v1/rpc/notify_live_console 로 anon/authenticated가 직접 호출 가능 →
--   live-console 토픽에 가짜 broadcast를 주입할 수 있었음(advisor: 0028/0029).
-- 조치:
--   1) search_path 고정(0011) — DEFINER 함수의 스키마 탈취 방지.
--   2) anon/authenticated/public 의 EXECUTE 권한 회수 — 트리거 실행은
--      호출 역할의 EXECUTE 권한과 무관하므로 트리거 동작에는 영향 없음.

alter function public.notify_live_console() set search_path = '';

revoke execute on function public.notify_live_console() from public;
revoke execute on function public.notify_live_console() from anon;
revoke execute on function public.notify_live_console() from authenticated;
