-- pool_events — 인력풀 접점 이벤트 로그 (Phase B-1)
-- ----------------------------------------------------------------
-- 배경 (PRODUCT_DIRECTION §6):
--   가용성 신선도·신뢰 점수(응답률/응답속도)의 근거 데이터. 운행 데이터 연동 없이
--   옹보딩 안에서 수집 가능한 이벤트만 기록한다.
--   event_type 관례 (코드에서 상수로 관리):
--     link_view        pull 링크(/p/[token]) 열람
--     interest_click   pull 페이지에서 특정 공고 '관심 있음' 클릭 (job_id 기록)
--     ping_sent        가용성 확인/재컨택 SMS 발송
--     ping_reply       ping에 대한 인바운드 응답
--     availability_set 가용성 값 변경 (meta: {from, to, source: manual|pull|ping|cron})
--     dormant_transition  60일 무활동 자동 휴면 전이 (cron)
--   meta: 이벤트별 부가정보(JSONB, 자유).
--
-- RLS: rls-lockdown 방침대로 정책 0개로 활성화 — anon/authenticated 전면 차단,
--      서버(service_role, createServiceClient)만 접근.
--
-- 재실행 안전: 멱등 (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS pool_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  applicant_id BIGINT NOT NULL REFERENCES applicants (id) ON DELETE CASCADE,
  job_id BIGINT REFERENCES jobs (id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 지원자별 최근 활동 조회(신선도·신뢰 점수 산출)용
CREATE INDEX IF NOT EXISTS pool_events_applicant_created_idx
  ON pool_events (applicant_id, created_at DESC);

-- 이벤트 유형별 집계(파일럿 KPI: 열람률/관심률)용
CREATE INDEX IF NOT EXISTS pool_events_type_created_idx
  ON pool_events (event_type, created_at DESC);

ALTER TABLE pool_events ENABLE ROW LEVEL SECURITY;
