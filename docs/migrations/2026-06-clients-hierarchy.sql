-- 화주사(고객사) 계층 도입 — "화주사 → 지점 → 공고"의 첫 단계.
-- ----------------------------------------------------------------
-- 배경: 지금까지 지점은 branches 테이블로만 존재하고 상위 '화주사' 개념이 없었다.
-- 배민 비마트, 당근 등 고객사 단위로 지점·공고를 묶어 관리할 수 있도록 clients를 신설하고
-- branches에 client_id를 추가한다. (jobs.client_id/branch_id FK는 다음 단계에서)
--
-- 무중단 원칙: 컬럼 추가는 전부 nullable/기본값. 기존 데이터는 '배민 비마트' 기본 화주사로 귀속.
-- 확정슬롯은 화주사 단위 on/off(uses_slots)로만 우선 도입. 슬롯 스키마 일반화는 추후.

-- 1) clients 테이블 신설
create table if not exists clients (
  id          bigserial primary key,
  name        text not null unique,
  -- 'baemin_bmart' | 'danggeun' | 'general' (라벨은 프론트에서 매핑)
  client_type text not null default 'general',
  -- 확정슬롯(지점×타임×요일) 구인을 쓰는 화주사인지
  uses_slots  boolean not null default false,
  contact_name  text,
  contact_phone text,
  memo        text,
  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 2) branches에 소속 화주사 FK 추가 (지점이 사라져도 화주사는 유지: set null 아님, 지점→화주사는 필수에 가깝지만
--    무중단 위해 nullable + on delete set null)
alter table branches
  add column if not exists client_id bigint references clients(id) on delete set null;

-- 3) 기본 화주사 1개 생성 (현재 운영 지점은 모두 배민 비마트 = 슬롯 사용)
insert into clients (name, client_type, uses_slots, sort_order)
values ('배민 비마트', 'baemin_bmart', true, 0)
on conflict (name) do nothing;

-- 4) 소속 없는 기존 지점을 기본 화주사로 귀속
update branches
set client_id = (select id from clients order by id asc limit 1)
where client_id is null;

-- 5) 조회 성능용 인덱스
create index if not exists idx_branches_client_id on branches(client_id);
