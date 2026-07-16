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

/**
 * 인력 보강(단건) — 전화번호로 옹매니징 배송원 상세를 조회. 지원자 상세 패널 표시용.
 * **개인정보·금액은 반입하지 않는다**: resident_number·계좌·신분증URL·정산 금액 컬럼은 select 자체 금지.
 * 반환은 차종·백업전문가·담당매니저·소속 배송라인·정산 개월 수(요약)뿐. 매칭 없으면 null.
 * (delivery_workers는 소규모라 전량 로드 후 전화 정규화 매칭 — 포맷 차이 방어.)
 */
export interface OngmanagingWorkerDetail {
  vehicleType: string | null;
  isBackupSpecialist: boolean;
  managerName: string | null;
  lines: { lineName: string; clientName: string | null }[];
  settledMonths: number;
  lastSettledMonth: string | null; // 'YYYY-MM'
}

export async function fetchWorkerDetailByPhone(phone: string): Promise<OngmanagingWorkerDetail | null> {
  if (!isOngmanagingConfigured()) return null;
  const target = normalizePhone(phone);
  if (!target) return null;
  const client = createOngmanagingClient();

  // 1) delivery_workers 매칭 (금액·주민번호·계좌 컬럼 제외)
  const { data: workers, error: wErr } = await client
    .from(CONFIG.workersTable)
    .select("id, phone, vehicle_type, is_backup_specialist, manager_name");
  if (wErr) throw new Error(`[ongmanaging] worker detail lookup failed: ${wErr.message}`);
  const worker = (workers ?? []).find(
    (w) => normalizePhone(String((w as { phone: string | null }).phone ?? "")) === target
  ) as
    | { id: string; vehicle_type: string | null; is_backup_specialist: boolean | null; manager_name: string | null }
    | undefined;
  if (!worker) return null;

  // 2) 소속 배송라인 (worker_delivery_lines → delivery_lines → clients)
  const lines: { lineName: string; clientName: string | null }[] = [];
  const { data: wdl } = await client
    .from("worker_delivery_lines")
    .select("delivery_line_id")
    .eq("worker_id", worker.id);
  const lineIds = [
    ...new Set(
      (wdl ?? []).map((r) => (r as { delivery_line_id: string | null }).delivery_line_id).filter(Boolean)
    ),
  ] as string[];
  if (lineIds.length > 0) {
    const { data: dls } = await client
      .from("delivery_lines")
      .select("id, line_name, client_id")
      .in("id", lineIds);
    const clientIds = [
      ...new Set(
        (dls ?? []).map((r) => (r as { client_id: string | null }).client_id).filter(Boolean)
      ),
    ] as string[];
    const clientNameById = new Map<string, string>();
    if (clientIds.length > 0) {
      const { data: cls } = await client.from("clients").select("id, name").in("id", clientIds);
      for (const c of cls ?? []) {
        const row = c as { id: string; name: string | null };
        if (row.name) clientNameById.set(row.id, row.name);
      }
    }
    for (const dl of dls ?? []) {
      const row = dl as { line_name: string | null; client_id: string | null };
      lines.push({
        lineName: row.line_name ?? "(이름 없음)",
        clientName: row.client_id ? clientNameById.get(row.client_id) ?? null : null,
      });
    }
  }

  // 3) 정산 개월 수 + 최근월 — year/month만 (금액 컬럼 select 금지)
  const { data: settlements } = await client
    .from(CONFIG.settlementsTable)
    .select("year, month")
    .eq("worker_id", worker.id);
  const monthSet = new Set<string>();
  for (const s of settlements ?? []) {
    const row = s as { year: number | null; month: number | null };
    if (row.year && row.month) monthSet.add(`${row.year}-${String(row.month).padStart(2, "0")}`);
  }
  const months = [...monthSet].sort();

  return {
    vehicleType: worker.vehicle_type ?? null,
    isBackupSpecialist: worker.is_backup_specialist === true,
    managerName: worker.manager_name ?? null,
    lines,
    settledMonths: months.length,
    lastSettledMonth: months.length ? months[months.length - 1] : null,
  };
}

/**
 * 화주사 마스터 — 옹매니징 화주사(clients) + 배송라인(delivery_lines) + 집계(client_performance_view).
 * 어드민 '화주사·라인 현황' 브라우징용(읽기 전용). 개인정보·금액 미반입 — 회사·라인 운영 데이터만.
 * 미구성 시 빈 배열.
 */
export interface ClientMasterLine {
  lineName: string;
  workDays: string | null;
  guaranteedDeliveries: number | null;
  startDate: string | null;
  endDate: string | null;
}
export interface ClientMaster {
  id: string;
  name: string;
  lineCount: number;
  workerCount: number;
  lines: ClientMasterLine[];
}

export async function fetchClientsMaster(): Promise<ClientMaster[]> {
  if (!isOngmanagingConfigured()) return [];
  const client = createOngmanagingClient();

  // 화주사별 라인수·배정인원 집계 뷰
  const { data: perf, error: pErr } = await client
    .from("client_performance_view")
    .select("id, name, total_delivery_lines, assigned_workers");
  if (pErr) throw new Error(`[ongmanaging] clients master lookup failed: ${pErr.message}`);

  // 배송라인 상세 → 화주사별 그룹
  const { data: dls } = await client
    .from("delivery_lines")
    .select("client_id, line_name, work_days, guaranteed_deliveries, start_date, end_date");
  const linesByClient = new Map<string, ClientMasterLine[]>();
  for (const r of dls ?? []) {
    const row = r as {
      client_id: string | null;
      line_name: string | null;
      work_days: string | null;
      guaranteed_deliveries: number | null;
      start_date: string | null;
      end_date: string | null;
    };
    if (!row.client_id) continue;
    const arr = linesByClient.get(row.client_id) ?? [];
    arr.push({
      lineName: row.line_name ?? "(이름 없음)",
      workDays: row.work_days ?? null,
      guaranteedDeliveries: row.guaranteed_deliveries ?? null,
      startDate: row.start_date ?? null,
      endDate: row.end_date ?? null,
    });
    linesByClient.set(row.client_id, arr);
  }

  return (perf ?? [])
    .map((p) => {
      const row = p as {
        id: string;
        name: string | null;
        total_delivery_lines: number | null;
        assigned_workers: number | null;
      };
      return {
        id: row.id,
        name: row.name ?? "(이름 없음)",
        lineCount: Number(row.total_delivery_lines ?? 0),
        workerCount: Number(row.assigned_workers ?? 0),
        lines: linesByClient.get(row.id) ?? [],
      };
    })
    .sort((a, b) => b.lineCount - a.lineCount || a.name.localeCompare(b.name));
}

/**
 * 활동 중(활성 계약 ∪ 지난달 확정 정산) 배송원의 {전화(정규화), 이름} — 재활용 후보 발굴용.
 * ※ 이름(PII)은 '최소 필드만 반입' 정책 하에서만 사용. 미구성 시 빈 배열.
 */
export interface OngmanagingWorker {
  phone: string;
  name: string | null;
}
export async function fetchActiveContractWorkers(): Promise<OngmanagingWorker[]> {
  if (!isOngmanagingConfigured()) return [];
  const client = createOngmanagingClient();

  // 활성 계약 + 지난달 확정 정산 worker_id 합집합
  const { year, month } = kstLastMonth();
  const [contractsRes, settlementsRes] = await Promise.all([
    client.from(CONFIG.contractsTable).select("worker_id").in("contract_status", CONFIG.activeStatuses),
    client
      .from(CONFIG.settlementsTable)
      .select("worker_id")
      .eq("year", year)
      .eq("month", month)
      .eq("status", CONFIG.settledStatus),
  ]);
  const ids = [
    ...new Set([
      ...uniqueWorkerIds(contractsRes.data as { worker_id: string | null }[] | null),
      ...uniqueWorkerIds(settlementsRes.data as { worker_id: string | null }[] | null),
    ]),
  ];
  if (ids.length === 0) return [];

  const out: OngmanagingWorker[] = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const { data: workers } = await client
      .from(CONFIG.workersTable)
      .select("phone, name")
      .in("id", ids.slice(i, i + CHUNK_SIZE));
    for (const w of workers ?? []) {
      const row = w as { phone: string | null; name: string | null };
      const p = normalizePhone(String(row.phone ?? ""));
      if (p) out.push({ phone: p, name: row.name ?? null });
    }
  }
  return out;
}

/** 전체 배송원 전화번호(정규화) 집합 — 재활용 모수(비활동 포함) 산정용. 이름 미조회(집계용). */
export async function fetchAllWorkerPhones(): Promise<Set<string>> {
  const result = new Set<string>();
  if (!isOngmanagingConfigured()) return result;
  const client = createOngmanagingClient();
  const { data: workers, error } = await client.from(CONFIG.workersTable).select("phone");
  if (error) {
    console.error("[ongmanaging] all worker phones failed", error);
    return result;
  }
  for (const w of workers ?? []) {
    const p = normalizePhone(String((w as { phone: string | null }).phone ?? ""));
    if (p) result.add(p);
  }
  return result;
}
