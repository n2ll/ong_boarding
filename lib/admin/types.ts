import { isValidApplicantBirthDate } from "../applicant-form.ts";

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

/**
 * 상태 배지 색. styles/theme.css의 상태 토큰과 같은 값이지만,
 * 여기는 `${color}1A` 처럼 알파를 이어 붙여 쓰는 자리라 var()가 아니라
 * 구체적인 hex여야 한다. 토큰 값을 바꾸면 여기도 같이 바꾼다.
 */
export const STATUS_COLORS: Record<string, string> = {
  "스크리닝 전": "#A8A29E", // gray-400 미러
  "스크리닝 중": "#57534E", // gray-600 — 배지 텍스트 12px는 4.5:1 필요(gray-500 미러는 4.18로 미달)
  "스크리닝 완료": "#3A5CC0", // --info
  기타: "#5A3596", // --copilot
  확정인력: "#268158", // --success
  대기자: "#A96200", // --warning
  부적합: "#D92D20", // --error
  이탈: "#B42318", // --error-strong
};

/**
 * 배지 "텍스트"용 파생 맵 — STATUS_COLORS는 도트·배경(알파 합성)용이라 밝은 상태색이 있고,
 * 그대로 12px 텍스트에 쓰면 대비가 깨진다('스크리닝 전' #A8A29E는 자기 칩 위 2.5:1).
 * 텍스트로 쓸 때는 반드시 이 맵을 쓸 것.
 */
export const STATUS_TEXT_COLORS: Record<string, string> = {
  ...STATUS_COLORS,
  "스크리닝 전": "#57534E", // gray-600 — 칩 위 6.5:1
  확정인력: "#14603E", // --success-strong — 본색은 칩 위 4.15:1로 미달
  대기자: "#92400E", // --warning-strong — 본색 4.08:1 미달
  부적합: "#B42318", // --error-strong — 본색 4.09:1 미달('이탈'과 같은 hex지만 칩 틴트·라벨이 다르다)
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
// 실제 달력에 없는 날짜면(테스트·오입력 쓰레기 값) null 반환.
const MIN_WORKING_AGE = 15;
export function calcAge(birth_date: string | null | undefined): number | null {
  if (!birth_date || !isValidApplicantBirthDate(birth_date)) return null;
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
//
// ⚠️ 이건 **비마트 슬롯 보드 전용**이다(지점×슬롯 확정/대기 집계, effectiveSlot과 짝). '이 사람이 언제
// 가능한가'를 묻는 노출 규칙·파이프라인 조건은 applicantAvailableSlots()를 쓴다 — 다른 질문이라 다른 함수다.
// 여기에 자유 입력 파서를 넣으면 슬롯 보드의 대기 인원 수가 조용히 바뀐다(같은 개념이 아니므로 통합하지 말 것).
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

/** 값이 없는 사람을 고르는 필터 값 — 노출 규칙의 '미확인'과 같은 문자열(두 화면이 같은 뜻으로 쓴다). */
export const SLOT_UNKNOWN = "미확인";

/** 4슬롯 표시 라벨 — 화면마다 '평일오전'/'평일 오전'/'평일 · 오전'으로 갈렸던 표기를 한 곳에서 정한다. */
export const SLOT_LABEL: Record<SlotKey, string> = {
  평일오전: "평일 오전",
  평일오후: "평일 오후",
  주말오전: "주말 오전",
  주말오후: "주말 오후",
};

/**
 * 자유 입력 시간대 → 오전/오후 판정 규칙.
 *
 * **12시를 기준으로 앞뒤 각 2시간 이상 근무하면 그 슬롯**으로 본다(실무자에게도 이 한 줄로 설명된다).
 * 4슬롯은 낮 근무 체계라 야간·새벽은 어느 슬롯도 아니다 — 미확인으로 남긴다(추측 금지).
 *
 * 검증하며 버린 두 방식:
 *  · 시작 시각만 보기(오전=12시 전 시작) → `9:00~13:00`이 오후 라인에도 걸렸다(오후 겹침 1시간).
 *  · 폼 시간 창 겹침(오전 09~14 / 오후 12~17) → `13:00~18:00`이 '오전'(1시간 겹침)으로,
 *    `6:00~10:00`은 아침 근무인데 '미확인'으로 뒤집혔다.
 */
const SLOT_MIN_HOURS = 2; // 12시 앞(또는 뒤)으로 이만큼 일해야 그 슬롯으로 인정
const NIGHT_START = 18; // 이 시각 이후 시작 = 야간(4슬롯 밖)
const DAWN_END = 9; // 이 시각 이전 종료 = 새벽(4슬롯 밖)

export interface SlotJudgment {
  slots: SlotKey[];
  /** 요일은 알지만 시간대를 모른다(또는 4슬롯 밖 야간) — 슬롯은 비우고 사실만 표시한다. */
  partial: boolean;
  source: "self" | "form_token" | "parsed" | "none";
}

/**
 * 희망 시간대 판정 — **이 함수 하나만** 쓴다(노출 규칙 · 파이프라인 조건 바 공용).
 *
 * 실데이터(645명)가 세 모양이라 그대로 비교하면 3분의 1만 잡힌다:
 *  ① 폼 4슬롯 토큰 250명 — `평일(월~금) 오전 타임 (09:00 ~ 14:00)` → 토큰 그대로 판정
 *  ② 자유 입력 171명 — `월, 화, 수, 목, 금 9:00~18:00` → 요일→평일/주말, 시각 창 겹침→오전/오후
 *  ③ 단서 없음 206명 — 값이 `~` 한 글자(폼 잔여물) → 어떤 파서로도 못 채운다 → '미확인'
 *
 * 파서는 **추측하지 않는다**: 요일·시각이 문자로 있을 때만 해석하고, 시각이 없으면 partial로 남긴다.
 * 종료시각이 시작보다 작으면(9:00~6:00 처럼 12시간제 표기) +12시간으로 본다 — 그래도 창에 안 걸리면 partial.
 *
 * confirmed_slot은 **쓰지 않는다** — 비마트 슬롯 체계 전용 개념(사장님 확인). '언제 가능한가'와 다른 질문이다.
 */
export function applicantAvailableSlots(a: {
  available_slots?: string[] | null;
  work_hours?: string | null;
}): SlotJudgment {
  // ① 자기 신고(최근에 직접 알려준 값)가 있으면 그것만 본다.
  const self = (a.available_slots ?? []).filter((s): s is SlotKey =>
    (SLOTS as readonly string[]).includes(s)
  );
  if (self.length > 0) return { slots: [...new Set(self)], partial: false, source: "self" };

  const raw = (a.work_hours ?? "").trim();
  if (!raw) return { slots: [], partial: false, source: "none" };

  // ② 폼 4슬롯 토큰 — 콤마로 나뉜 각 토큰이 (평일|주말)+(오전|오후)를 함께 가질 때만 채택.
  const tokenSlots = new Set<SlotKey>();
  for (const tok of raw.split(",").map((t) => t.trim())) {
    const day = tok.includes("주말") ? "주말" : tok.includes("평일") ? "평일" : null;
    const time = tok.includes("오전") ? "오전" : tok.includes("오후") ? "오후" : null;
    if (day && time) tokenSlots.add(`${day}${time}` as SlotKey);
  }
  if (tokenSlots.size > 0) return { slots: [...tokenSlots], partial: false, source: "form_token" };

  // ③ 자유 입력 — 요일과 시각을 각각 해석한다(콤마가 요일 구분자라 토큰 분리가 안 통한다).
  // '평일'·'주말' 단어를 **먼저** 반영하고 지운다 — 안 지우면 '평일'의 '일'이 일요일로 읽혀
  // 평일만 가능한 분이 주말 전용으로 뒤집힌다.
  // '매일'·'주7일'은 평일+주말 둘 다다. 이 단어들을 먼저 처리하고 지우지 않으면 '평일'·'매일'의 '일'이
  // 일요일로 읽혀 **평일 근무자가 주말 전용으로 정반대 분류**된다(AI가 뽑은 자유 텍스트에서 실제로 오는 형태).
  const everyDay = /매일|주\s*7\s*일/.test(raw);
  const hasWeekdayWord = everyDay || raw.includes("평일");
  const hasWeekendWord = everyDay || raw.includes("주말");
  const dayScan = raw.replace(/평일|주말|매일/g, "");
  const weekday = hasWeekdayWord || /[월화수목금]/.test(dayScan);
  const weekend = hasWeekendWord || /[토일]/.test(dayScan);
  if (!weekday && !weekend) return { slots: [], partial: false, source: "none" };

  const dayParts: ("평일" | "주말")[] = [];
  if (weekday) dayParts.push("평일");
  if (weekend) dayParts.push("주말");

  const times = [...raw.matchAll(/(\d{1,2}):(\d{2})/g)].map(
    (m) => Number(m[1]) + Number(m[2]) / 60
  );
  // 시각이 없으면 요일만 아는 상태(`월, 화, 수, 목, 금 ~` 형태) — 슬롯을 추측하지 않는다.
  if (times.length === 0) return { slots: [], partial: true, source: "parsed" };
  let start = times[0];
  // 문자열에 '오후'가 명시돼 있고 시각이 12시간제로 적혔으면 그대로 읽는다(추측이 아니라 표기 반영).
  // 이게 없으면 `오후 1:30~5:30`이 새벽으로 뒤집혀 미확인이 된다.
  const pmMarked = /오후/.test(raw) && !/오전/.test(raw);
  if (pmMarked && start < 12) {
    start += 12;
    for (let i = 1; i < times.length; i++) if (times[i] < 12) times[i] += 12;
  }
  if (start >= NIGHT_START) return { slots: [], partial: true, source: "parsed" }; // 야간 시작
  let end = times.length > 1 ? times[1] : null;
  // 시작과 종료가 같은 값(`0:00~0:00`·`7:00~7:00`)은 범위가 아니다 — 12시간제 보정으로 그럴싸한
  // 답을 만들면 판정 불가한 쓰레기 값이 '확정'으로 새어 들어온다.
  if (end !== null && end === start) return { slots: [], partial: true, source: "parsed" };
  // 종료가 `0:00`이면 범위가 아니다(폼 잔여물) 또는 자정을 넘기는 교대다 — 어느 쪽이든 슬롯 판정 불가.
  // 아래 12시간제 보정(+12)에 넘기면 `0:30~0:00`이 `0:30~12:00`(오전 확정)으로 그럴싸하게 새어 들어온다.
  if (end !== null && end === 0) return { slots: [], partial: true, source: "parsed" };
  if (end !== null && end < start) {
    // `9:00~6:00` 처럼 종료를 12시간제로 적은 경우 → 오후로 읽는다.
    end += 12;
    // 보정해도 여전히 시작보다 이르면 다음날까지 이어지는 교대·야간 — 슬롯 판정 불가.
    if (end <= start) return { slots: [], partial: true, source: "parsed" };
  }
  if (end !== null && end < DAWN_END) return { slots: [], partial: true, source: "parsed" }; // 새벽 종료

  const timeParts: ("오전" | "오후")[] = [];
  if (end === null) {
    // 종료를 모르면 시작 시각만으로 한쪽만 인정한다(범위를 모르는데 넓게 잡지 않는다).
    timeParts.push(start < 12 ? "오전" : "오후");
  } else {
    const beforeNoon = Math.max(0, Math.min(end, 12) - start);
    const afterNoon = Math.max(0, end - Math.max(start, 12));
    if (beforeNoon >= SLOT_MIN_HOURS) timeParts.push("오전");
    if (afterNoon >= SLOT_MIN_HOURS) timeParts.push("오후");
    // 짧은 근무(예: 10:30~12:30)는 어느 쪽도 2시간을 못 채운다 — 더 긴 쪽으로 판정한다.
    if (timeParts.length === 0 && beforeNoon !== afterNoon) {
      timeParts.push(beforeNoon > afterNoon ? "오전" : "오후");
    }
  }
  if (timeParts.length === 0) return { slots: [], partial: true, source: "parsed" };

  const out = new Set<SlotKey>();
  for (const d of dayParts) for (const t of timeParts) out.add(`${d}${t}` as SlotKey);
  return { slots: [...out], partial: false, source: "parsed" };
}

// 확정 슬롯 매트릭스·PPC 표용 — 매니저가 확정한 slot이 있으면 그것, 없으면 희망(work_hours)로 폴백.
export function effectiveSlot(a: {
  confirmed_slot?: string | null;
  work_hours?: string | null;
}): string | null {
  if (a.confirmed_slot && a.confirmed_slot.trim()) return a.confirmed_slot;
  return a.work_hours ?? null;
}
