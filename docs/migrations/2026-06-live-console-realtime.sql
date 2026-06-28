-- 실시간 응대 콘솔 자동 갱신 (③ 실시간)
-- 방식: DB 트리거에서 realtime.send(public broadcast)로 "변경됨" 신호만 발행.
--   - PII/행 데이터는 싣지 않는다(table/op만). 브라우저는 신호를 받으면 기존
--     service-role API(loadChats/loadHandoffs)로 재조회 → anon에 데이터 노출 0.
--   - 토픽 'live-console', 이벤트 'changed', private=false (인증 불필요한 공개 채널).
-- 발화 지점:
--   - messages INSERT        : 인입/아웃바운드 등 새 메시지 → 대화 목록·미리보기 갱신
--   - job_candidates INSERT  : 새 후보 편입
--   - job_candidates UPDATE  : agent_stage 변경(예: paused 편입/해제) → 인계 큐 갱신

create or replace function public.notify_live_console()
returns trigger
language plpgsql
security definer
as $$
begin
  perform realtime.send(
    jsonb_build_object('table', tg_table_name, 'op', tg_op),
    'changed',
    'live-console',
    false
  );
  return null;
end;
$$;

drop trigger if exists trg_messages_live_console on public.messages;
create trigger trg_messages_live_console
  after insert on public.messages
  for each row execute function public.notify_live_console();

drop trigger if exists trg_jc_insert_live_console on public.job_candidates;
create trigger trg_jc_insert_live_console
  after insert on public.job_candidates
  for each row execute function public.notify_live_console();

drop trigger if exists trg_jc_stage_live_console on public.job_candidates;
create trigger trg_jc_stage_live_console
  after update on public.job_candidates
  for each row
  when (old.agent_stage is distinct from new.agent_stage)
  execute function public.notify_live_console();
