-- 2026-08-18 · match_applicant_on_message: last_message_at 이 과거로 밀리지 않게 GREATEST 보정
--
-- ■ 무엇이 문제였나
--
-- messages BEFORE INSERT 트리거(trg_match_applicant → match_applicant_on_message)가
-- `last_message_at = NEW.created_at` 으로 무조건 덮어썼다. 인입 스위퍼(cron)처럼 놓친
-- 메시지를 **원래 수신 시각으로 늦게** 삽입하는 경로가 있어, 그 순간 '마지막 메시지
-- 시각'이 실제보다 과거로 되돌아갔다.
--
-- 실측(2026-08-14): 답장 보유자 132명 중 23명이 자기 마지막 답장보다 과거였다.
-- 그때 백필로 값은 맞췄지만 원인이 이 트리거라 그대로 두면 재발한다.
-- 이 값을 읽는 화면: 답장 큐 14일 필터 · 실시간 응대 정렬/14일 창 · 파이프라인
-- '방치 오래된 순' · 지원자 상세 · 공고 화면.
--
-- ■ 의미는 바꾸지 않았다
--
-- '마지막 메시지(방향 무관)' 그대로다. outbound가 시각을 갱신하는 동작, inbound만
-- unread_count 를 올리는 동작, phone 자동 매핑 모두 그대로다.
-- 바뀐 것은 "과거 시각으로는 되돌리지 않는다"(GREATEST) 하나 —
-- 그리고 unread_count 에 COALESCE(컬럼이 NULL 허용이라 NULL+1=NULL 로 카운터가
-- 조용히 죽는 함정 방어. 현재 NULL 0건이라 동작 변화 없음).
--
-- ■ 적용 후 검증 (롤백 트랜잭션에서 실측)
--   · 현재 값보다 과거 inbound 삽입 → last_message_at 유지 ✓ (예전엔 되돌아갔다)
--   · 현재 시각 inbound → 갱신 + unread +1 ✓
--   · outbound → 시각만 갱신, unread 그대로 ✓
--
-- ■ 되돌리기: 이 파일 이전 버전의 함수 본문(GREATEST/COALESCE 없는 버전)으로
--   create or replace 하면 된다. 데이터 변경은 없다.

create or replace function public.match_applicant_on_message()
returns trigger
language plpgsql
as $function$
begin
  -- phone으로 applicant_id 자동 매핑
  if NEW.applicant_id is null then
    NEW.applicant_id := (
      select id from applicants
      where phone = NEW.applicant_phone
      limit 1
    );
  end if;

  -- last_message_at 업데이트 (과거로는 되돌리지 않는다)
  if NEW.applicant_id is not null then
    update applicants
    set
      last_message_at = greatest(coalesce(last_message_at, NEW.created_at), NEW.created_at),
      unread_count = case
        when NEW.direction = 'inbound' then coalesce(unread_count, 0) + 1
        else unread_count
      end
    where id = NEW.applicant_id;
  end if;

  return NEW;
end;
$function$;
