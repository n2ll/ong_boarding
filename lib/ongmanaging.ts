import { createClient } from "@supabase/supabase-js";

/**
 * 옹매니징(배송원 계약·정산 관리, **별도 Supabase 프로젝트**) 조회 어댑터 — 서버 전용.
 *
 * 용도: 재컨택 발송 전 "이 지원자가 옹매니징에서 활성 계약 중인가" 대조.
 * 가동 중인 기사에게 재컨택 문자를 보내면 안 되므로, 활성 계약 번호를 걸러낸다.
 *
 * 실스키마 (2026-07-06 확인):
 *   contracts(worker_id UUID, contract_status TEXT: '체결완료'|'계약종료'|'승인대기', ...)
 *   monthly_settlements(worker_id UUID, year INT, month INT, status: 'confirmed'|'draft', ...)
 *     → delivery_workers(id UUID, phone TEXT, ...)
 *   전화번호는 delivery_workers에만 있어 2단계 조회.
 *   '현재 활동 중' 판정은 두 신호의 합집합:
 *     ① 활성 계약 = contract_status 체결완료 + 승인대기 (승인대기 = 곧 투입, 보수적 포함)
 *     ② 지난달 확정 정산 = monthly_settlements(직전월, status='confirmed') — "실제로 뛰었다"의
 *        가장 확실한 증거 (2026-06 확정 76건 > 활성 계약 60건: 계약 상태가 늦게 갱신되는
 *        케이스를 정산이 잡아준다). ※ driver_monthly_settlements는 2026년 미사용 — 대상 아님.
 *
 * 미구성(URL/KEY 없음) 시 조회는 빈 Set을 반환하고, 호출부는
 * isOngmanagingConfigured()로 분기해 "미구성" 안내를 표시한다.
 */

// ─────────────────────────────────────────────────────────────
// CONFIG — 옹매니징 스키마가 바뀌면 **이 블록(과 env 값)만** 고치면 된다.
//   ONGMANAGING_SUPABASE_URL         옹매니징 프로젝트 URL (필수)
//   ONGMANAGING_SERVICE_ROLE_KEY     service_role 키 (필수, 서버 전용)
//   ONGMANAGING_CONTRACTS_TABLE      계약 테이블명 (기본 'contracts')
//   ONGMANAGING_WORKERS_TABLE        배송원 테이블명 (기본 'delivery_workers')
//   ONGMANAGING_ACTIVE_STATUSES      활성 계약 상태 CSV (기본 '체결완료,승인대기')
//   ONGMANAGING_SETTLEMENTS_TABLE    월 정산 테이블명 (기본 'monthly_settlements')
//   ONGMANAGING_SETTLED_STATUS       확정 정산 상태 값 (기본 'confirmed')
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  url: process.env.ONGMANAGING_SUPABASE_URL,
  serviceRoleKey: process.env.ONGMANAGING_SERVICE_ROLE_KEY,
  contractsTable: process.env.ONGMANAGING_CONTRACTS_TABLE || "contracts",
  workersTable: process.env.ONGMANAGING_WORKERS_TABLE || "delivery_workers",
  activeStatuses: (process.env.ONGMANAGING_ACTIVE_STATUSES || "체결완료,승인대기")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  settlementsTable: process.env.ONGMANAGING_SETTLEMENTS_TABLE || "monthly_settlements",
  settledStatus: process.env.ONGMANAGING_SETTLED_STATUS || "confirmed",
};

const CHUNK_SIZE = 500;

/** 전화번호 정규화 — 숫자만 남김 ('010-1234-5678' → '01012345678'). 양쪽 DB 포맷 차이 흡수. */
export function normalizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

/** URL과 service_role 키가 둘 다 설정됐을 때만 true. */
export function isOngmanagingConfigured(): boolean {
  return Boolean(CONFIG.url && CONFIG.serviceRoleKey);
}

// lib/supabase.ts의 createServiceClient()와 동일한 옵션 (no-store fetch, 세션 없음)
function createOngmanagingClient() {
  return createClient(CONFIG.url!, CONFIG.serviceRoleKey!, {
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, cache: "no-store" }),
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

type OngClient = ReturnType<typeof createOngmanagingClient>;

/** worker_id 목록 → 정규화된 전화번호 집합 (UUID IN은 500개 단위 청크). */
async function phonesByWorkerIds(client: OngClient, workerIds: string[]): Promise<Set<string>> {
  const result = new Set<string>();
  for (let i = 0; i < workerIds.length; i += CHUNK_SIZE) {
    const chunk = workerIds.slice(i, i + CHUNK_SIZE);
    const { data: workers, error: wErr } = await client
      .from(CONFIG.workersTable)
      .select("phone")
      .in("id", chunk);
    if (wErr) {
      throw new Error(`[ongmanaging] workers lookup failed: ${wErr.message}`);
    }
    for (const row of (workers ?? []) as { phone: string | null }[]) {
      if (row.phone) {
        const p = normalizePhone(row.phone);
        if (p) result.add(p);
      }
    }
  }
  return result;
}

function uniqueWorkerIds(rows: { worker_id: string | null }[] | null): string[] {
  return [
    ...new Set((rows ?? []).map((r) => r.worker_id).filter((v): v is string => Boolean(v))),
  ];
}

/** KST 기준 직전 월 {year, month}. (Vercel 서버는 UTC — usage.ts kstDay와 동일한 +9h 보정) */
function kstLastMonth(): { year: number; month: number } {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  let year = kst.getUTCFullYear();
  let month = kst.getUTCMonth() + 1; // 1~12 (현재 월)
  month -= 1;
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return { year, month };
}

/** 옹매니징에서 활성 계약 중인 배송원의 전화번호(정규화) 전체 집합. */
export async function fetchAllActiveContractPhones(): Promise<Set<string>> {
  if (!isOngmanagingConfigured()) {
    console.warn(
      "[ongmanaging] not configured (ONGMANAGING_SUPABASE_URL / ONGMANAGING_SERVICE_ROLE_KEY 미설정) — 빈 결과 반환"
    );
    return new Set();
  }
  const client = createOngmanagingClient();
  const { data: contracts, error: cErr } = await client
    .from(CONFIG.contractsTable)
    .select("worker_id")
    .in("contract_status", CONFIG.activeStatuses);
  if (cErr) {
    throw new Error(`[ongmanaging] contracts lookup failed: ${cErr.message}`);
  }
  const workerIds = uniqueWorkerIds(contracts as { worker_id: string | null }[] | null);
  if (workerIds.length === 0) return new Set();
  return phonesByWorkerIds(client, workerIds);
}

/** 지난달(KST) 확정 정산이 있는 배송원의 전화번호(정규화) 전체 집합 — "실제로 뛰었다" 신호. */
export async function fetchLastMonthSettledPhones(): Promise<Set<string>> {
  if (!isOngmanagingConfigured()) {
    console.warn("[ongmanaging] not configured — 빈 결과 반환");
    return new Set();
  }
  const client = createOngmanagingClient();
  const { year, month } = kstLastMonth();
  const { data: settlements, error: sErr } = await client
    .from(CONFIG.settlementsTable)
    .select("worker_id")
    .eq("year", year)
    .eq("month", month)
    .eq("status", CONFIG.settledStatus);
  if (sErr) {
    throw new Error(`[ongmanaging] settlements lookup failed: ${sErr.message}`);
  }
  const workerIds = uniqueWorkerIds(settlements as { worker_id: string | null }[] | null);
  if (workerIds.length === 0) return new Set();
  return phonesByWorkerIds(client, workerIds);
}

/** '현재 활동 중' 두 신호를 한 번에 — 활성 계약 ∪ 지난달 확정 정산. */
export interface WorkingPhoneSignals {
  activeContract: Set<string>;
  recentSettlement: Set<string>;
}
export async function fetchWorkingPhoneSignals(): Promise<WorkingPhoneSignals> {
  const [activeContract, recentSettlement] = await Promise.all([
    fetchAllActiveContractPhones(),
    fetchLastMonthSettledPhones(),
  ]);
  return { activeContract, recentSettlement };
}

/**
 * 정규화된 전화번호 목록을 받아, 그중 옹매니징 활성 계약 중인 번호의 부분집합을 반환.
 * 미구성 시 빈 Set 반환 (에러 아님 — 호출부에서 configured 플래그로 분기).
 */
export async function fetchActiveContractPhones(phones: string[]): Promise<Set<string>> {
  const targets = new Set(phones.map(normalizePhone).filter(Boolean));
  if (targets.size === 0) return new Set();
  const active = await fetchAllActiveContractPhones();
  return new Set([...targets].filter((p) => active.has(p)));
}
