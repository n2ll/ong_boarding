export interface Applicant {
  id: number;
  created_at: string;
  name: string;
  birth_date: string;
  phone: string;
  location: string;
  own_vehicle: string;
  license_type: string;
  vehicle_type: string;
  branch1: string;
  branch2: string | null;
  work_hours: string;
  introduction: string | null;
  experience: string | null;
  available_date: string | null;
  self_ownership: string;
  screening: string | null;
  status: string;
  branch: string | null;
  source: string;
  filter_pass: string | null;
  note: string | null;
  memo: string | null;
  sort_order: number | null;
  last_message_at: string | null;
  unread_count: number;
  start_date: string | null;
  confirmed_slot: string | null;
  confirmed_branch: string | null;
  current_branch: string | null;
  churned_at: string | null;
  churn_reason: string | null;
  agent_stage?: string | null;
  baemin_id: string | null;
  guide_sent: boolean;
  onboarding_call_status: string | null;
  kakao_channel_friend: boolean | null;
  bname: string | null;
  sigungu: string | null;
  sido: string | null;
  lat: number | null;
  lng: number | null;
  geo_precision: string | null;
  availability: "즉시가능" | "이번주가능" | "휴면" | null;
  availability_updated_at: string | null;
  line_experience: string[] | null;
  hired_at: string | null;
}

/** availability 유효값 — null(미확인)은 별도 처리 */
export const AVAILABILITY_VALUES = ["즉시가능", "이번주가능", "휴면"] as const;

export interface Message {
  id: string;
  applicant_id: number | null;
  applicant_phone: string;
  direction: "inbound" | "outbound";
  body: string;
  status: string;
  sent_by: string | null;
  solapi_msg_id: string | null;
  created_at: string;
  reasoning?: string | null;
}

export interface Heartbeat {
  device_id: string;
  last_seen_at: string;
  pending_count: number;
  battery_level: number;
  app_version: string | null;
}

export interface Branch {
  id: number;
  name: string;
  sort_order: number;
  active: boolean;
  client_id?: number | null;
  slot_capacity?: Record<string, number>;
  ai_facts?: string | null;
}

export type ClientType = "baemin_bmart" | "danggeun" | "general";

export interface Client {
  id: number;
  name: string;
  client_type: ClientType;
  uses_slots: boolean;
  contact_name: string | null;
  contact_phone: string | null;
  memo: string | null;
  active: boolean;
  sort_order: number;
}

export const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  baemin_bmart: "배민 비마트",
  danggeun: "당근",
  general: "일반",
};

export type Tab =
  | "dashboard"
  | "applicants"
  | "contact"
  | "inbox"
  | "hope-slots"
  | "confirmed-slots"
  | "recommend"
  | "branches"
  | "site-managers"
  | "agent"
  | "playground"
  | "danggeun"
  | "baemin"
  | "danggeun-practice"
  | "klod"
  | "ops"
  | "report"
  | "sourcing"
  | "clients"
  | "team";

export const STATUS_COLORS: Record<string, string> = {
  "스크리닝 전": "#9CA3AF",
  "스크리닝 중": "#6b7280",
  "스크리닝 완료": "#0EA5E9",
  기타: "#8B5CF6",
  확정인력: "#10b981",
  대기자: "#f59e0b",
  부적합: "#ef4444",
  이탈: "#7f1d1d",
};

export const ALL_STATUSES = [
  "스크리닝 전",
  "스크리닝 중",
  "스크리닝 완료",
  "기타",
  "확정인력",
  "대기자",
  "부적합",
  "이탈",
];

export const ACTIVE_STATUSES = ["스크리닝 전", "스크리닝 중", "스크리닝 완료", "확정인력", "대기자"];

export const SLOTS = ["평일오전", "평일오후", "주말오전", "주말오후"] as const;
export type SlotKey = (typeof SLOTS)[number];

// 소싱팀 원칙: 오전 3, 오후 4 (평일/주말 동일).
export const DEFAULT_SLOT_CAPACITY: Record<SlotKey, number> = {
  평일오전: 3,
  평일오후: 4,
  주말오전: 3,
  주말오후: 4,
};

export function getSlotCapacity(branch: Branch | undefined, slot: SlotKey): number {
  const v = branch?.slot_capacity?.[slot];
  return typeof v === "number" ? v : DEFAULT_SLOT_CAPACITY[slot];
}

// birth_date(YYMMDD) → 만 나이.
// 세기(19xx/20xx) 판정은 고정 컷오프(50) 대신 '근로 가능 나이' 기준으로 한다.
// 시니어 플랫폼이라 1940년대생(예: 480302=1948)이 핵심 인구인데, 고정 컷오프로는
// 이들이 2048년생(음수 나이)으로 뒤집혔다. 2000+yy가 미래이거나 15세 미만이면 1900년대로 본다.
// 월/일이 유효 범위를 벗어나면(테스트·오입력 쓰레기 값) null 반환.
const MIN_WORKING_AGE = 15;
export function calcAge(birth_date: string | null | undefined): number | null {
  if (!birth_date || !/^\d{6}$/.test(birth_date)) return null;
  const yy = parseInt(birth_date.slice(0, 2), 10);
  const mm = parseInt(birth_date.slice(2, 4), 10);
  const dd = parseInt(birth_date.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const today = new Date();
  let year = 2000 + yy;
  // 2000년대 해석이 미래이거나 근로 불가능하게 어리면 1900년대생으로 해석(시니어).
  if (today.getFullYear() - year < MIN_WORKING_AGE) year -= 100;
  let age = today.getFullYear() - year;
  const beforeBirthday =
    today.getMonth() + 1 < mm || (today.getMonth() + 1 === mm && today.getDate() < dd);
  if (beforeBirthday) age--;
  return age;
}

// work_hours 값을 짧은 표기로 ("평일(월~금) 오전 타임 (09:00 ~ 14:00)" → "평일 오전")
export function shortWorkHours(wh: string | null | undefined): string {
  if (!wh) return "";
  return wh
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const day = token.includes("주말") ? "주말" : token.includes("평일") ? "평일" : "";
      const time = token.includes("오전") ? "오전" : token.includes("오후") ? "오후" : "";
      return day && time ? `${day} ${time}` : token;
    })
    .join(", ");
}

// work_hours 텍스트(콤마 join된 4슬롯 중 선택값) → 슬롯 매칭
export function matchesSlot(workHours: string | null | undefined, slot: SlotKey): boolean {
  if (!workHours) return false;
  const wantPyeongil = slot.startsWith("평일");
  const wantMorning = slot.endsWith("오전");
  return workHours
    .split(",")
    .map((t) => t.trim())
    .some((tok) => {
      const dayOk = wantPyeongil ? tok.includes("평일") : tok.includes("주말");
      const timeOk = wantMorning ? tok.includes("오전") : tok.includes("오후");
      return dayOk && timeOk;
    });
}

// 확정 슬롯 매트릭스·PPC 표용 — 매니저가 확정한 slot이 있으면 그것, 없으면 희망(work_hours)로 폴백.
export function effectiveSlot(a: {
  confirmed_slot?: string | null;
  work_hours?: string | null;
}): string | null {
  if (a.confirmed_slot && a.confirmed_slot.trim()) return a.confirmed_slot;
  return a.work_hours ?? null;
}
