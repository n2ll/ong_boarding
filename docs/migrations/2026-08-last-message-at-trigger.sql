-- 2026-08 · applicants.last_message_at 불일치 23건 백필
--
-- ⚠️ 이 파일은 처음에 "messages INSERT 트리거를 새로 만든다"는 내용이었다. 그건 **틀렸고**
--    적용 직후 되돌렸다. 같은 실수를 반복하지 않도록 경위를 남긴다.
--
-- ■ 무엇을 잘못 봤나
--
-- 앱 코드에서 last_message_at 을 쓰는 곳을 grep 했더니 인입 웹훅
-- (app/api/webhooks/supabase-new-message/route.ts)의 `rpc("increment_unread").then(성공, 실패)`
-- **실패 콜백** 한 곳뿐이었다. 그리고 그 함수는 DB에 존재하지 않으며(pg_proc 0건),
-- Supabase 쿼리는 실패해도 reject 가 아니라 { error } 로 resolve 하므로 그 폴백은
-- 한 번도 실행된 적이 없다. 여기까지는 사실이다.
--
-- 그래서 "이 컬럼은 아무도 갱신하지 않는다"고 결론냈는데, **DB 트리거를 확인하지 않았다.**
-- messages 테이블에는 이미 `trg_match_applicant`(BEFORE INSERT)가 붙어 있고 그 안에서
-- last_message_at 갱신과 inbound unread_count +1 을 한다. 즉 갱신은 정상 동작 중이었다.
--
-- 트리거를 하나 더 붙였더니 inbound 한 건에 unread_count 가 +2 됐다(트랜잭션 안에서 실측).
-- 즉시 drop 했다.
--
-- 교훈: 컬럼 갱신 경로를 찾을 때 앱 코드 grep 만으로 끝내지 말 것. 이 레포는 messages 에
-- 트리거 5개(match_applicant · classify_outbound_sms · live_console broadcast 등)를 쓰고 있다.
--
-- ■ 기존 트리거의 실제 동작 (참고 · 트랜잭션 안에서 확인)
--
--   inbound  → last_message_at = 그 메시지의 created_at,  unread_count += 1
--   outbound → last_message_at = 그 메시지의 created_at,  unread_count 그대로
--
--   즉 last_message_at 은 '마지막 inbound'가 아니라 **'마지막 메시지(방향 무관)'** 이다.
--   그리고 GREATEST 를 쓰지 않으므로, 오래된 메시지가 나중에 삽입되면 값이 과거로 밀린다.
--
-- ■ 그래서 이 파일이 실제로 하는 일: 백필뿐
--
-- 위 의미(마지막 메시지 = 방향 무관)대로면 last_message_at 은 마지막 inbound 보다 앞설 수 없는데,
-- 실측에서 23명이 자기 마지막 답장보다 과거였다(과거 out-of-order 삽입·임포트 흔적으로 추정).
-- 그 23명을 실제 마지막 답장 시각으로 맞춘다.
--
-- unread_count 는 백필하지 않는다: 매니저가 이미 읽은 대화까지 미확인으로 되살리면
-- 큐가 옛 건으로 가득 찬다.
--
-- 적용 결과(실측): 마지막 답장보다 과거 23명 → 0명.
--                  메시지 보유자 211명 전원, last_message_at == 마지막 메시지 시각(불일치 0).

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

-- ■ 확인 (0이 나와야 한다)
--   select count(*) from applicants a
--     join (select applicant_id, max(created_at) m from messages
--            where applicant_id is not null group by applicant_id) l on l.applicant_id = a.id
--    where a.last_message_at is null or a.last_message_at < l.m;
--
-- ■ 남은 과제(별건, 아직 안 함)
--   기존 트리거가 GREATEST 없이 덮어써서 값이 과거로 밀릴 수 있다. 고치면 이 컬럼을 읽는
--   화면 5곳(답장 큐 14일 필터 · 실시간 응대 정렬 · 파이프라인 방치순 · 상세 · 공고)의
--   판정이 함께 바뀌므로, 의미를 정하고(마지막 메시지 vs 마지막 답장) 한 번에 결정할 일이다.
