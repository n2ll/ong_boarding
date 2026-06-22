-- 공고(jobs) FK 계층화 — "지점 → 공고"를 ID로 연결. (화주사→지점은 이전 마이그레이션)
-- ----------------------------------------------------------------
-- 배경: jobs.branch가 지점 '이름 문자열'이라 동명·오타에 취약하고 계층 질의가 안 된다.
-- branch_id(→branches), client_id(→clients) FK를 추가하고 기존 데이터를 이름 매칭으로 백필한다.
-- 무중단 원칙: 기존 branch 문자열 컬럼은 그대로 둔다(전환기 병행). 신규 저장은 FK 우선.

alter table jobs
  add column if not exists branch_id bigint references branches(id) on delete set null;
alter table jobs
  add column if not exists client_id bigint references clients(id) on delete set null;

-- 1) branch 문자열 → branch_id 백필 (이름 일치)
update jobs j
set branch_id = b.id
from branches b
where j.branch_id is null
  and j.branch is not null
  and b.name = j.branch;

-- 2) branch_id → client_id 백필 (지점의 소속 화주사)
update jobs j
set client_id = b.client_id
from branches b
where j.client_id is null
  and j.branch_id = b.id;

create index if not exists idx_jobs_branch_id on jobs(branch_id);
create index if not exists idx_jobs_client_id on jobs(client_id);
