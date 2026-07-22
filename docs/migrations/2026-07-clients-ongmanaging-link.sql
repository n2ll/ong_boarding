-- 옹매니징(외부 Supabase 프로젝트) 화주사 ↔ 로컬 clients 링크
-- ----------------------------------------------------------------
-- 배경: 실제 화주사 원본은 옹매니징(배송원 계약·정산 관리, 별도 프로젝트)에 있고,
--       /shippers 화면은 그 clients(id=UUID)를 읽기 전용으로 미러링만 한다.
--       한편 공고(jobs.client_id, bigint FK)는 로컬 clients(id=bigint)만 참조할 수 있어,
--       "/shippers에서 본 화주사로는 공고를 만들 수 없다"는 단절이 있었다(플로우 감사 주제 A3).
--
-- 해결: 로컬 clients에 옹매니징 화주사 UUID 참조 컬럼을 두어, 동기화(sync-ongmanaging)가
--       옹매니징 화주사를 로컬 clients로 upsert(이름 갱신·중복 방지)한다. 그러면 공고 폼은
--       기존대로 로컬 clients를 셀렉터 소스로 쓰면서 실제 화주사를 고를 수 있고, FK도 유지된다.
--
-- 무중단 원칙: nullable 컬럼 + 부분 unique 인덱스만 추가. 기존 로컬 clients(배민 비마트 시드 등)는
--             건드리지 않는다. 동기화 시 이름이 일치하는 기존 행은 이 컬럼만 채워 흡수(어댑트)한다.

-- 1) 옹매니징 화주사 UUID 참조 컬럼
alter table clients
  add column if not exists ongmanaging_client_id uuid;

-- 2) 한 옹매니징 화주사가 두 로컬 행에 중복 매핑되지 않도록 — 값이 있을 때만 유니크
create unique index if not exists uq_clients_ongmanaging_client_id
  on clients(ongmanaging_client_id)
  where ongmanaging_client_id is not null;
