-- 2026-08 · jobs.slot_keys 신설 — 시간대 '매칭용 값'을 사람이 읽는 문장과 분리한다
--
-- 왜: `jobs.slot` 한 칸이 두 가지 일을 겸했다.
--   ① 사람이 읽는 문장 — 지원자 카드 표시 · 에이전트가 다른 공고를 안내할 때 인용
--   ② 기계가 맞추는 값 — 지원자의 4슬롯(평일/주말 × 오전/오후)과 겹치는지 판정
-- 한 칸에 둘을 넣으면 반드시 파싱이 끼어들고, 그 파싱이 이미 두 번 오판했다:
--   · M4 게이트: `평일 오전~오후`에서 '평일오전'만 읽어 **오후도 되는 공고를 오후 가능한 분에게 접었다**
--   · M6 게이트: 제목의 `오전`·`주말` 낱말이 **답장 라우팅 근거로 새어** 들어갔다
-- 그래서 매니저에게 '평일오전, 평일오후'처럼 기계용 토큰을 대신 입력하라고 안내하는 지경이 됐다(철회).
--
-- 해법: 매칭용 값은 **칩으로 고르는 배열**(이 컬럼), 사람이 읽는 상세 시간은 기존 `slot`(자유 텍스트).
-- 이러면 `lib/pool-fit.jobSlotTokens`(자유 텍스트 파서)를 삭제할 수 있다 — 코드가 줄어든다.
-- 노출 규칙(`exposure_rule.slot`)·파이프라인 조건 바는 이미 같은 4슬롯 칩을 쓰므로 어휘가 통일된다.
--
-- 되돌리기: `alter table jobs drop column slot_keys;` (기존 `slot` 표시·안내는 그대로 동작한다)

alter table jobs add column if not exists slot_keys text[];

-- 4슬롯 어휘만 허용 — 빈 배열/NULL은 '시간대 미지정'(판정하지 않음)을 뜻한다.
alter table jobs drop constraint if exists chk_jobs_slot_keys;
alter table jobs
  add constraint chk_jobs_slot_keys
  check (
    slot_keys is null
    or slot_keys <@ ARRAY['평일오전','평일오후','주말오전','주말오후']::text[]
  );

-- 기존 값 승계 — 비마트 시절 저장된 4슬롯 값(공백 없는 정확 일치)만 옮긴다. 자유 문장은 옮기지 않는다(추측 금지).
update jobs
set slot_keys = ARRAY[slot]
where slot in ('평일오전','평일오후','주말오전','주말오후')
  and slot_keys is null;
