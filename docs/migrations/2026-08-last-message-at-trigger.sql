-- 2026-08 · applicants.last_message_at / unread_count 을 트리거로 갱신한다
--
-- ■ 무엇이 고장 나 있었나
--
-- 지원자가 답장을 보내면 applicants.last_message_at 이 올라가야 한다. 이 값으로
-- 아래 화면들이 '누가 언제 마지막으로 연락했는지'를 판단한다:
--   · 대시보드 '내가 답할 차례' 큐   — 최근 14일 필터의 기준
--   · 실시간 응대 좌측 목록          — 최근 활동순 정렬 · 14일 창
--   · 파이프라인                     — '연락 이력' 표시 · 방치 오래된 순 정렬
--   · 지원자 상세 · 공고 화면
--
-- 그런데 이 컬럼을 갱신하는 코드는 인입 웹훅
-- (app/api/webhooks/supabase-new-message/route.ts:196) 한 곳뿐이고,
-- 그 코드가 `supabase.rpc("increment_unread", …).then(성공, 실패)` 의 **실패 콜백**
-- 안에 들어 있다. 두 가지가 겹쳐 이 폴백은 한 번도 실행된 적이 없다:
--
--   1) increment_unread 함수가 DB에 존재하지 않는다 (pg_proc 실측 0건).
--   2) Supabase 쿼리 빌더는 실패해도 reject 하지 않고 { error } 로 **resolve** 한다.
--      그래서 함수가 없어도 '성공' 콜백이 불리고 실패 콜백은 건너뛴다.
--
-- 실측(2026-08-14, 프로덕션):
--   답장(inbound) 보유자                     132명
--   last_message_at 이 실제 마지막 답장보다 과거   23명
--   unread_count > 0 인 사람                  0명   ← 카운터가 한 번도 오른 적 없음
--
-- 지금 눈에 안 띄는 이유는 최근 14일 답장이 1건뿐이라서다. 공고 6~7개를 동시에
-- 올려 답장이 쏟아지는 순간, 답장한 사람이 매니저 큐에 안 뜨고 화면에는
-- "모두 응대했어요 👍" 가 표시된다. 낭비가 아니라 리드 유실이다.
--
-- ■ 왜 애플리케이션 코드가 아니라 트리거인가
--
-- messages 에 행을 넣는 경로가 웹훅 하나가 아니다(수동 발송·캠페인·에이전트 응대).
-- 앞으로 생길 경로까지 같은 규칙을 지키게 하려면 삽입 지점이 아니라 테이블에
-- 붙여야 한다. messages 에는 이미 트리거 4개가 붙어 있어(trg_match_applicant,
-- tr_classify_outbound_sms, trg_messages_live_console, agent-draft-on-inbound)
-- 관례상으로도 여기가 맞는 자리다.
--
-- ■ 규칙
--
--   inbound  → last_message_at 갱신 + unread_count += 1
--   outbound → 건드리지 않는다.
--     매니저 발신으로 last_message_at 이 올라가면 '답을 기다리는 대화'가 마치
--     방금 연락 온 것처럼 보여 큐 판단이 뒤집힌다. 발신만 있는 대화를 찾는 일은
--     이미 미리보기 API 가 with_manual=1 로 messages 를 직접 뒤져 처리한다.
--
--   시각은 messages.created_at 을 쓴다(now() 아님). 지연 처리·재처리에서도
--   실제 수신 시각이 남아야 한다.
--
--   과거로 되돌리지 않는다(GREATEST) — 오래된 메시지를 나중에 넣어도
--   최신 시각이 뒤로 밀리지 않게.

create or replace function public.bump_applicant_last_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.direction = 'inbound' and new.applicant_id is not null then
    update applicants
       set last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at),
           unread_count    = coalesce(unread_count, 0) + 1
     where id = new.applicant_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bump_last_message on public.messages;

create trigger trg_bump_last_message
after insert on public.messages
for each row
execute function public.bump_applicant_last_message();

-- ■ 기존 데이터 백필 — 뒤처진 23명을 실제 마지막 답장 시각으로 맞춘다.
--   unread_count 는 백필하지 않는다: 매니저가 이미 읽은 대화까지 미확인으로
--   되살리면 큐가 옛 건으로 가득 찬다. 앞으로 오는 답장부터 센다.
update applicants a
   set last_message_at = l.real_last_inbound
  from (
    select applicant_id, max(created_at) as real_last_inbound
      from messages
     where direction = 'inbound' and applicant_id is not null
     group by applicant_id
  ) l
 where a.id = l.applicant_id
   and (a.last_message_at is null or a.last_message_at < l.real_last_inbound);

-- ■ 적용 후 확인 (0이 나와야 한다)
--   select count(*) from applicants a
--     join (select applicant_id, max(created_at) m from messages
--            where direction='inbound' group by applicant_id) l on l.applicant_id = a.id
--    where a.last_message_at is null or a.last_message_at < l.m;
--
-- ■ 되돌리기
--   drop trigger if exists trg_bump_last_message on public.messages;
--   drop function if exists public.bump_applicant_last_message();
--   (백필된 값은 실제 메시지에서 계산한 것이라 되돌릴 필요가 없다.)
