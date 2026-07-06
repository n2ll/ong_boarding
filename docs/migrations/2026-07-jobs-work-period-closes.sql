-- 공고 기간 구분 + 모집 마감시각 (Phase C 파일럿 피드백, 2026-07-06)
-- ----------------------------------------------------------------
-- 배경: 파일럿 테스트에서 실무자 피드백 —
--   ① 지원자가 "하루짜리 백업인지, 정기 라인인지" 구분 못 하면 관심 표시를 주저함.
--   ② 긴급 건은 실제 마감이 있으므로(당일 투입 등) 카드에 마감시각을 노출해
--      정직한 긴박감을 만든다. 가짜 카운트다운·허위 소멸 문구는 금지(신뢰 자산).
--
--   work_period: '하루'(당일·단발 백업) / '단기'(며칠~몇 주) / '정기'(상시 라인).
--   closes_at: 모집 마감시각. 경과 시 pull 페이지 미노출(코드 판단) — status와 별개.
--     Phase D shift_request의 '마감시각' 개념을 jobs에 선반영.
--
-- 재실행 안전: 멱등 (IF NOT EXISTS).

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS work_period TEXT
    CHECK (work_period IN ('하루', '단기', '정기')),
  ADD COLUMN IF NOT EXISTS closes_at TIMESTAMPTZ;
