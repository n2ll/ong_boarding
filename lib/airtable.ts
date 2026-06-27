/**
 * Airtable 어댑터 — 옹고잉 공식 홈페이지(Tally 폼) 지원자 인력풀을 가져온다.
 *
 * base/table id는 비밀이 아니므로 env 미설정 시 기존 운영 값으로 폴백.
 * 토큰(AIRTABLE_TOKEN)만 .env.local에 둔다. 권한: schema.bases:read + data.records:read.
 */

const AIRTABLE_API = "https://api.airtable.com/v0";
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appDZtqIjmLmjCNXT";
const APPLICANTS_TABLE = process.env.AIRTABLE_APPLICANTS_TABLE || "tbld4sE6c79GXxwkE";

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

/** 옹고잉 지원자 테이블 전체 레코드를 페이지네이션으로 모두 가져온다(최신순). */
export async function listAirtableApplicants(): Promise<AirtableRecord[]> {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error("AIRTABLE_TOKEN 미설정");

  const out: AirtableRecord[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(`${AIRTABLE_API}/${BASE_ID}/${APPLICANTS_TABLE}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("sort[0][field]", "Submitted at");
    url.searchParams.set("sort[0][direction]", "desc");
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { records?: AirtableRecord[]; offset?: string };
    out.push(...(json.records ?? []));
    offset = json.offset;
  } while (offset);

  return out;
}

// ── 옹고잉 지원자 테이블 필드명 ────────────────────────────────
const F = {
  name: "성함을 작성해주세요",
  status: "구인 상태",
  birth: "생년월일 작성해주세요.(주민번호 앞6자리)",
  phoneFormula: "연락처 수정",
  phoneRaw: "연락처를 작성해주세요.",
  applyRoute: "지원 경로를 작성해주세요.",
  sido: "거주지",
  sigungu: "시/군/구를 선택해주세요.",
  addrRest: "나머지 주소(동/면/리)를 작성해주세요.",
  workHoursFormula: "희망 근로 시간",
  workDays: "근로 희망하는 요일을 선택해주세요.",
  ownVehicle: "자차로 업무를 진행하실 의향이 있으신가요?",
  license: "소지한 운전면허를 선택해주세요",
  vehicleType: "차량 종류를 작성해주세요.",
  payOwn: "급여를 본인 계좌로 지급 받는데 이상은 없나요?",
  career: "경력 사항을 작성해주세요",
  similar: "배송 업무와 유사한 일을 하신 적 있으신가요?상세히 서술해주세요.",
  availDate: "업무 투입 가능한 날짜 또는 희망 날짜를 선택해주세요.",
} as const;

/** applicants INSERT용으로 가공된 한 줄. branch/branch1은 Airtable에 없어 '미지정' 고정(매니저가 지정). */
export interface MappedApplicant {
  airtable_record_id: string;
  name: string;
  phone: string;
  phone_norm: string;
  birth_date: string;
  location: string;
  own_vehicle: string;
  license_type: string;
  vehicle_type: string;
  work_hours: string;
  available_date: string | null;
  self_ownership: string;
  experience: string | null;
  source: "homepage";
  branch: string;
  branch1: string;
  status: string;
  filter_pass: "Y" | "N";
  note: string | null;
  airtable_raw: Record<string, unknown>;
}

const PLACEHOLDER = "미지정";
const VALID_LICENSES = ["1종 보통", "2종 보통", "1종 대형"];

function str(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(", ");
  return String(v).trim();
}

/** 구인 상태 → applicants.status (유효값: 스크리닝 전 / 확정인력 / 부적합) */
function mapStatus(s: string): string {
  if (s === "구인 완료") return "확정인력";
  if (s === "탈락") return "부적합";
  return "스크리닝 전"; // 대기 중 및 그 외 → 매니저 검토 대기. AI 자동발송 없음.
}

/**
 * Airtable 레코드 → applicants 매핑. 필수값(이름·전화)이 없으면 null.
 * 지오코딩(lat/lng)은 호출 측(route)에서 location으로 별도 수행.
 */
export function mapAirtableApplicant(rec: AirtableRecord): MappedApplicant | null {
  const f = rec.fields;

  const name = str(f[F.name]);
  const phoneNorm = str(f[F.phoneFormula] || f[F.phoneRaw]).replace(/[^0-9]/g, "");
  if (!name || !phoneNorm) return null;

  // 생년월일: number 타입이라 앞자리 0이 유실됨 → 6자리 0패딩
  const birthRaw = str(f[F.birth]).replace(/[^0-9]/g, "");
  const birth_date = birthRaw ? birthRaw.padStart(6, "0").slice(-6) : "";

  const location =
    [str(f[F.sido]), str(f[F.sigungu]), str(f[F.addrRest])].filter(Boolean).join(" ") || PLACEHOLDER;

  const ownRaw = str(f[F.ownVehicle]);
  const own_vehicle = ownRaw === "네" ? "있음" : ownRaw === "아니요" ? "없음" : PLACEHOLDER;

  const license_type = str(f[F.license]) || PLACEHOLDER;
  const vehicle_type = str(f[F.vehicleType]) || PLACEHOLDER;

  const work_hours =
    [str(f[F.workDays]), str(f[F.workHoursFormula])].filter(Boolean).join(" ") || "미확인";

  const available_date = str(f[F.availDate]) || null;

  const payRaw = str(f[F.payOwn]);
  const self_ownership = payRaw.startsWith("네") ? "문제 없음" : payRaw || "미확인";

  const experience = [str(f[F.career]), str(f[F.similar])].filter(Boolean).join("\n") || null;

  const route = str(f[F.applyRoute]);
  const note = route ? `유입경로: ${route}` : null;

  const filterPass =
    own_vehicle === "있음" &&
    VALID_LICENSES.includes(license_type) &&
    self_ownership === "문제 없음";

  return {
    airtable_record_id: rec.id,
    name,
    phone: phoneNorm,
    phone_norm: phoneNorm,
    birth_date,
    location,
    own_vehicle,
    license_type,
    vehicle_type,
    work_hours,
    available_date,
    self_ownership,
    experience,
    source: "homepage",
    branch: PLACEHOLDER,
    branch1: PLACEHOLDER,
    status: mapStatus(str(f[F.status])),
    filter_pass: filterPass ? "Y" : "N",
    note,
    airtable_raw: f,
  };
}
