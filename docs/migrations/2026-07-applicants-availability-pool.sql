-- 인력풀 가용성 축 + pull 채널 토큰 + 라인 경험 + 매니저 확정 시각 (Phase B-1)
-- ----------------------------------------------------------------
-- 배경 (PRODUCT_DIRECTION §6, 2026-07-04 실무자 인터뷰 확정):
--   - availability: 채용 단계(status)와 분리된 두 번째 축. 3단계(즉시가능/이번주가능/휴면),
--     null = 미확인(수집 전). 휴면 자동 전이 기준은 "마지막 응답/활동 후 60일" — 코드(cron)에서 판단,
--     여기서는 값 저장만. 휴면은 삭제가 아니라 기본 발송 타깃 제외이며 선별 재컨택으로 복구 가능.
--   - access_token: 무로그인 pull 링크(/p/[token] 맞춤 공고 페이지)용 식별자. 지원자별 고유.
--   - line_experience: 투입/확정 시 자동 태깅되는 라인 경험 이력(자유 태그 배열).
--     라인 마스터 테이블 없이 시작 — 벤치(Tier 0) 자격 판단은 라인마다 달라 태그 매칭으로 시작.
--   - hired_at: 매니저가 status를 '확정인력'으로 처음 전환한 시각. TTF(요청→확정) 리드타임 측정 기반.
--     (churned_at 자동 기록과 대칭. 주의: 통화 등 "지원 건" 단위 개념은 향후 job_candidates 쪽에 기록)
--
-- 재실행 안전: 멱등 (IF NOT EXISTS).

ALTER TABLE applicants
  ADD COLUMN IF NOT EXISTS availability TEXT
    CHECK (availability IN ('즉시가능', '이번주가능', '휴면')),
  ADD COLUMN IF NOT EXISTS availability_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS access_token UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS line_experience TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS hired_at TIMESTAMPTZ;

-- pull 링크 토큰 조회용 (무로그인 접근 경로라 유니크 보장 필수)
CREATE UNIQUE INDEX IF NOT EXISTS applicants_access_token_uidx
  ON applicants (access_token);

-- 가용성 필터(인력풀 탭 · 웨이브 발송 타깃팅)용
CREATE INDEX IF NOT EXISTS applicants_availability_idx
  ON applicants (availability)
  WHERE availability IS NOT NULL;
