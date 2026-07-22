-- 공고 채널별 본문 저장 (플로우 감사 주제 D1 — 반자동 초안 인프라)
-- ----------------------------------------------------------------
-- 배경: AI 초안은 3채널(당근/알바몬/SMS)을 생성하지만 저장은 단일 jobs.body(알바몬 캐논)만 되어
--       채널 특화가 소실되고, 복제 시 3채널이 같은 본문이 됐다. 밴드/알바몬 유료 게시의 '반자동'
--       (에이전트 초안 → 사람 게시) 워크플로를 위해 채널별 본문을 함께 보관한다.
--
-- 설계: jobs.body는 그대로 캐논으로 유지(AI 스크리닝·pull·집계가 광범위 참조) + channel_bodies JSONB
--       에 {danggeun, albamon, sms} 부가 저장. 무중단(nullable). 기존 공고는 NULL(캐논 body만 존재).

alter table jobs
  add column if not exists channel_bodies jsonb;
