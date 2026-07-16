-- 2026-07-recruitment-blacklist.sql
-- 재채용 블랙리스트 — "절대 재채용 불가" 명단(노무 이슈·커뮤니케이션 핏 문제 등).
-- 옹보딩에서 지정/관리. **전화번호(정규화) 키** — 소스(옹보딩/TMS/옹매니징) 무관하게 차단한다.
-- 용도: 콜드 재컨택 대량발송 하드 제외 + (Phase B) 신규 편입 후보에서 제외.
-- 기존 applicants.status='부적합'/'이탈'(인력풀 제외)보다 강한 영구 개념 — 별도 레이어.

create table if not exists recruitment_blacklist (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,          -- 정규화(숫자만) 저장
  name text,                            -- 참고용(선택)
  reason text,                          -- 사유(노무 이슈/커뮤니케이션 핏 등)
  added_by text,                        -- 지정자(감사용)
  created_at timestamptz not null default now()
);

create index if not exists idx_recruitment_blacklist_phone on recruitment_blacklist (phone);

-- 서버(service_role) 전용 — anon/authenticated 차단(rls-lockdown 정책과 동일 posture).
alter table recruitment_blacklist enable row level security;

comment on table recruitment_blacklist is '절대 재채용 불가 명단(노무/커뮤니케이션 핏). phone 정규화 키 — 소스 무관 차단. 콜드 발송·편입에서 하드 제외.';
