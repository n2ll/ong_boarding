-- 공고에 모집 방식(외부 공개 모집 / 내부 인재풀 진행) 구분 추가 (#1 외부·내부 분리)
--   external : 공개 모집형 — 지원 폼(/apply?job=ID) + (광고 유포)로 불특정 다수 인입
--   internal : 인재풀 진행형 — 보유 인재풀에서 매니저가 골라 컨택
--   both     : 병행 — 둘 다
-- 기존 공고는 지금까지 지원 링크 기반이었으므로 external로 백필(default).

alter table public.jobs
  add column if not exists recruit_mode text not null default 'external';

alter table public.jobs drop constraint if exists jobs_recruit_mode_check;
alter table public.jobs
  add constraint jobs_recruit_mode_check
  check (recruit_mode in ('external', 'internal', 'both'));

comment on column public.jobs.recruit_mode is '모집 방식: external(공개 모집)·internal(인재풀 진행)·both(병행). UI 분기·리포팅 기준.';
