-- 공고 단가 구조화 + 공고별 AI 참고 정보 (Phase B-1)
-- ----------------------------------------------------------------
-- 배경 (PRODUCT_DIRECTION §6, 2026-07-04 실무자 인터뷰):
--   스크리닝 인계(paused) 54건의 주요 사유가 "단가·정산·계약·근무·차량 정보가 공고에 없어
--   AI가 답변 불가"였다. 단, 단가는 건당/일당/주급/월급 등 공고마다 성격이 유연하므로
--   대표 단가만 구조화(pay_type + pay_amount — pull 공고 카드 표시·필터용)하고,
--   나머지(정산 주기·계약 형태·4대보험·주말/공휴일·오전오후 병행·풀타임·렌트 차량 등)는
--   검증된 branches.ai_facts 패턴을 공고 레벨로 미러링한 jobs.ai_facts(자유 텍스트)에 담아
--   AI 응대 프롬프트에 주입한다. 기존 pay_info/policy_notes는 레거시 유지(추후 통합).
--
-- 재실행 안전: 멱등 (IF NOT EXISTS).

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS pay_type TEXT
    CHECK (pay_type IN ('건당', '일당', '주급', '월급', '혼합', '협의')),
  ADD COLUMN IF NOT EXISTS pay_amount INTEGER,  -- 대표 금액(원). pay_type 기준 단위 (건당이면 건당 단가)
  ADD COLUMN IF NOT EXISTS ai_facts TEXT;       -- 공고별 AI 참고 정보 (정산·계약·근무·차량 정책 등 자유 기재)
