-- 긴급 건(SOS) 기록 + 비용 원장 (Phase C 준비)
-- ----------------------------------------------------------------
-- 배경 (PRODUCT_DIRECTION §6, 2026-07-06 5차 인터뷰 확정):
--   - sos_requests: 긴급 결원·증차 건의 발생~해결 로그. TTF(요청 인지→해결) 앵커이자
--     건별 비용 원장. pool_events는 applicant_id NOT NULL이라 지원자와 무관한 '사건'을
--     담을 수 없어 전용 테이블로 신설. Phase D의 shift_request(웨이브 발송·마감시각·
--     수당)는 이 테이블을 확장하거나 대체한다 — 지금은 기록만, 발송 로직 없음.
--   - cost_ledger: 월별 운영비(백업인력 인건비·광고 재집행 등) 수기 입력.
--     '운영비 절감' 주장의 baseline. 시트/노션 분할 대신 옹보딩 안에 두기로 결정(v4).
--     SLA성 지출 중 배송원 공제분은 옹매니징 정산 데이터와 월 단위 대조.
--
-- RLS: rls-lockdown 방침 — 정책 0개로 활성화, 서버(service_role)만 접근.
-- 재실행 안전: 멱등 (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS sos_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),   -- 결원/증차 인지 시각 = TTF 시작점
  line_label TEXT NOT NULL,                        -- 라인/권역 라벨 (자유 텍스트, 예: '강서 새벽 배민')
  region TEXT,                                     -- 권역 (선택)
  vehicle TEXT,                                    -- 요구 차종 (선택)
  needed_count INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  job_id BIGINT REFERENCES jobs (id) ON DELETE SET NULL,  -- 실공고로 등록해 발송한 경우 연결
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'cancelled')),
  resolved_at TIMESTAMPTZ,                         -- 해결 시각 = TTF 끝점
  resolution TEXT CHECK (resolution IN ('internal_bench', 'yongcha', 'self_cover', 'external_hire', 'unresolved')),
  -- internal_bench 내부 벤치 투입 / yongcha 용차 / self_cover 팀원 직접 투입 /
  -- external_hire 외부 급구 채용 / unresolved 미해결 종결
  cost_krw INTEGER,                                -- 건 해결에 든 총 비용 (용차 프리미엄·환불·퀵비 등)
  duration_minutes INTEGER,                        -- 매니저 실소요 시간(분) — 체감 리소스, resolved_at-created_at(TTF)과 별개
  resolution_note TEXT
);

-- 홈 카드(진행 중 건)·월별 집계용
CREATE INDEX IF NOT EXISTS sos_requests_status_created_idx
  ON sos_requests (status, created_at DESC);

ALTER TABLE sos_requests ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS cost_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  month TEXT NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),  -- 'YYYY-MM' (KST 기준)
  category TEXT NOT NULL,
  -- 카테고리 관례 (코드 상수 COST_CATEGORIES에서 관리):
  --   backup_labor 백업인력 인건비 / ads 구인광고비 / sla SLA 위약(환불·퀵비 등) /
  --   education 교육비 / other 기타
  amount_krw BIGINT NOT NULL,
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cost_ledger_month_idx ON cost_ledger (month);

ALTER TABLE cost_ledger ENABLE ROW LEVEL SECURITY;
