import { Client } from "pg";
import { normalizePhone } from "./ongmanaging";

/**
 * 옹고잉 TMS(배송 운영, **AWS RDS Postgres `onggoing_prod`**) 읽기전용 조회 어댑터 — 서버 전용.
 *
 * 용도: "이 전화번호가 최근/예정 배송 스케줄이 있는 '활동 중 배송원'인가" 대조.
 *  - 재컨택 발송 제외(옹매니징 계약·정산 신호와 **병행**) + 상세패널 '활동 중' 배지의 실배차 근거.
 *  - 옹매니징(계약 상태)이 늦게 갱신되는 케이스를 TMS schedule(실제 배차 배정)이 보완한다.
 *
 * 실스키마 (2026-07-16 읽기전용 확인):
 *   "user"(id uuid PK, phone varchar[11자리 숫자], status enum ACTIVE|DELETED,
 *          role enum PRO|ADMIN, ...)  — phone 매칭원. ※ user는 예약어라 반드시 큰따옴표.
 *   schedule(id, worker_id uuid → "user".id, status enum COMPLETED|WAIT|WORK|DELETED,
 *            date_to_work date, ...)  — schedule 존재 = 실제 배차(스케줄 배정) 신호.
 *   '활동 중' 판정 = date_to_work가 최근 N일(기본 30) 이내이거나 미래(예정)인 schedule 보유
 *     + schedule.status ≠ DELETED(취소 배차 제외) + user.status ≠ DELETED(삭제 계정 제외).
 *   (미래 date_to_work는 CURRENT_DATE-N일 하한만으로 자연히 포함된다.)
 *   phone은 TMS에서 이미 숫자만이나, 양쪽 정규화(regexp_replace)로 포맷 차이를 방어한다.
 *
 * 미구성(TMS_DB_* 없음) 시 조회는 빈 Set을 반환하고, 호출부는 isTmsConfigured()로 분기한다.
 * **Vercel→AWS RDS 매요청 연결은 지양** — 이 어댑터는 주기 sync cron 경유로만 호출한다.
 */

// ─────────────────────────────────────────────────────────────
// CONFIG — TMS 접속/스키마가 바뀌면 **이 블록(과 env 값)만** 고치면 된다.
//   TMS_DB_HOST / TMS_DB_PORT / TMS_DB_NAME / TMS_DB_USER / TMS_DB_PASSWORD  접속(필수, 서버 전용)
//   TMS_DB_SSL              'false' 외에는 SSL 사용(RDS 기본, rejectUnauthorized=false)
//   TMS_TABLE_USER          배송원 테이블명 (기본 'user')
//   TMS_TABLE_SCHEDULE      스케줄 테이블명 (기본 'schedule')
//   TMS_ACTIVE_WINDOW_DAYS  '활동 중' 판정 창(일) (기본 30)
// ─────────────────────────────────────────────────────────────

/** 식별자(테이블명) 화이트리스트 — env는 신뢰하지만 SQL 주입 방어로 안전한 문자만 허용. */
function safeIdentifier(v: string | undefined, dflt: string): string {
  const s = (v || "").trim();
  return s && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : dflt;
}

function clampWindowDays(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 3650 ? n : dflt;
}

const CONFIG = {
  host: process.env.TMS_DB_HOST,
  port: Number(process.env.TMS_DB_PORT) || 5432,
  database: process.env.TMS_DB_NAME,
  user: process.env.TMS_DB_USER,
  password: process.env.TMS_DB_PASSWORD,
  ssl: (process.env.TMS_DB_SSL || "").toLowerCase() !== "false",
  userTable: safeIdentifier(process.env.TMS_TABLE_USER, "user"),
  scheduleTable: safeIdentifier(process.env.TMS_TABLE_SCHEDULE, "schedule"),
  windowDays: clampWindowDays(process.env.TMS_ACTIVE_WINDOW_DAYS, 30),
};

const CHUNK_SIZE = 1000;

/** 접속 정보(host/db/user/password)가 모두 설정됐을 때만 true. */
export function isTmsConfigured(): boolean {
  return Boolean(CONFIG.host && CONFIG.database && CONFIG.user && CONFIG.password);
}

function createTmsClient(): Client {
  return new Client({
    host: CONFIG.host,
    port: CONFIG.port,
    database: CONFIG.database,
    user: CONFIG.user,
    password: CONFIG.password,
    ssl: CONFIG.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
    statement_timeout: 20000,
  });
}

/**
 * 정규화된(또는 원시) 전화번호 목록 → 그중 TMS에서 '활동 중 배송원'인 번호의 부분집합(정규화형).
 * 미구성 시 빈 Set 반환(에러 아님 — 호출부에서 isTmsConfigured()로 분기).
 * 한 번의 접속으로 CHUNK_SIZE 단위 IN 매칭. 검증됨(2026-07-16 읽기전용, 활동 worker 51/546).
 */
export async function fetchActiveDeliveryPhones(phones: string[]): Promise<Set<string>> {
  const result = new Set<string>();
  if (!isTmsConfigured()) {
    console.warn("[tms] not configured (TMS_DB_* 미설정) — 빈 결과 반환");
    return result;
  }
  const targets = [...new Set(phones.map(normalizePhone).filter(Boolean))];
  if (targets.length === 0) return result;

  const u = `"${CONFIG.userTable}"`;
  const s = `"${CONFIG.scheduleTable}"`;
  const np = `regexp_replace(u.phone,'[^0-9]','','g')`;
  const sql =
    `SELECT DISTINCT ${np} AS np ` +
    `FROM ${u} u JOIN ${s} s ON s.worker_id = u.id ` +
    `WHERE s.date_to_work >= (CURRENT_DATE - make_interval(days => $2::int)) ` +
    `AND s.status::text <> 'DELETED' AND u.status::text <> 'DELETED' ` +
    `AND ${np} = ANY($1::text[])`;

  const client = createTmsClient();
  try {
    await client.connect();
    for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
      const chunk = targets.slice(i, i + CHUNK_SIZE);
      const { rows } = await client.query(sql, [chunk, CONFIG.windowDays]);
      for (const row of rows as { np: string | null }[]) {
        if (row.np) result.add(row.np);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
  return result;
}

const ACTIVE_PREDICATE =
  `s.date_to_work >= (CURRENT_DATE - make_interval(days => $1::int)) ` +
  `AND s.status::text <> 'DELETED' AND u.status::text <> 'DELETED'`;

/**
 * 활동 중 배송원의 {전화(정규화), 이름} 목록 — 재활용(재편입) 후보 발굴용.
 * ※ 이름(PII)을 함께 반환한다: 편입 대상은 '최소 필드(이름+전화)만' 반입한다는 정책에 한해서만 사용.
 * 미구성 시 빈 배열.
 */
export interface TmsWorker {
  phone: string;
  name: string | null;
}
export async function fetchActiveWorkers(): Promise<TmsWorker[]> {
  if (!isTmsConfigured()) return [];
  const u = `"${CONFIG.userTable}"`;
  const s = `"${CONFIG.scheduleTable}"`;
  const np = `regexp_replace(u.phone,'[^0-9]','','g')`;
  const sql =
    `SELECT DISTINCT ${np} AS phone, u.name ` +
    `FROM ${u} u JOIN ${s} s ON s.worker_id = u.id ` +
    `WHERE ${ACTIVE_PREDICATE} AND u.phone IS NOT NULL`;
  const client = createTmsClient();
  try {
    await client.connect();
    const { rows } = await client.query(sql, [CONFIG.windowDays]);
    return (rows as { phone: string | null; name: string | null }[])
      .filter((r) => r.phone)
      .map((r) => ({ phone: r.phone as string, name: r.name ?? null }));
  } finally {
    await client.end().catch(() => {});
  }
}

/** 전체(비삭제) 배송원 전화번호(정규화) 집합 — 재활용 모수(비활동 포함) 산정용. 이름 미조회(집계용). */
export async function fetchAllWorkerPhones(): Promise<Set<string>> {
  const result = new Set<string>();
  if (!isTmsConfigured()) return result;
  const u = `"${CONFIG.userTable}"`;
  const sql = `SELECT DISTINCT regexp_replace(phone,'[^0-9]','','g') AS phone FROM ${u} WHERE status::text <> 'DELETED' AND phone IS NOT NULL`;
  const client = createTmsClient();
  try {
    await client.connect();
    const { rows } = await client.query(sql);
    for (const r of rows as { phone: string | null }[]) if (r.phone) result.add(r.phone);
  } finally {
    await client.end().catch(() => {});
  }
  return result;
}
