/**
 * 지원자 화면(맞춤 공고 링크) fit 판정 — "이 자리가 나와 맞나"를 서버가 정한다.
 *
 * 왜 서버인가:
 *  · 판정 재료(좌표·정규화된 차량·시간대 파서)가 클라이언트에 없고, 좌표는 내려보내지 않는다(PII).
 *  · 판정 소스를 늘리면 안 된다 — 노출 규칙·파이프라인과 **같은 함수**(normalizeVehicleOwned·
 *    applicantAvailableSlots)를 재사용한다. 같은 개념 두 공식 금지.
 *  · 카드 순서는 서버가 확정한다 — 클라이언트는 백그라운드 갱신에서 재정렬하지 않는 규칙이 있다
 *    (읽는 중 순서가 바뀌면 시니어 오클릭).
 *
 * ⚠️ fit ≠ 노출. 'warn'이어도 카드는 **절대 숨기지 않는다** — 순서와 접기에만 쓴다.
 *    (차량이 새로 생긴 분을 막지 않는다. 노출 게이팅은 isExposed가 따로 담당.)
 * ⚠️ 추측 금지 — 요건이 **명시적으로 어긋났다고 확정될 때만** warn. 정보가 없으면 unknown이고,
 *    unknown은 맞는 자리와 같은 위 그룹에 둔다(조용한 강등 금지).
 */

import { normalizeVehicleOwned } from "./exposure";
import { applicantAvailableSlots, SLOTS, type SlotKey } from "./admin/types";

export type PoolFit = "ok" | "warn" | "unknown";

export interface PoolFitResult {
  fit: PoolFit;
  /** warn일 때만 채워진다 — 지원자에게 그대로 보여줄 짧은 사실 문장(확정 뉘앙스·탈락 뉘앙스 금지). */
  reasons: string[];
}

/**
 * 공고 근무시간(자유 텍스트 80자)에서 4슬롯 토큰을 뽑는다 — **명시 토큰만**.
 * `jobs.slot`은 자유 텍스트라 시각 파싱은 오탐 여지가 있다(계획 문서 '남는 위험 2').
 * '평일 오전' 같은 명시 표기가 있을 때만 판정하고, `월~금 9:00~18:00` 같은 값은 판정하지 않는다(unknown).
 */
export function jobSlotTokens(slot: string | null | undefined): SlotKey[] {
  const raw = (slot ?? "").replace(/\s/g, "");
  if (!raw) return [];
  // 부정 표기는 판정하지 않는다 — '평일오전 제외, 오후만'이 '평일오전'으로 **정반대** 해석된다.
  if (/제외|말고|불가|아님|빼고/.test(raw)) return [];
  const out: SlotKey[] = [];
  for (const key of SLOTS) {
    // '평일오전'(공백 제거 후) 형태가 그대로 들어 있을 때만 — '평일'+'오전'이 떨어져 있으면
    // '평일 저녁, 주말 오전' 같은 값에서 '평일오전'을 만들어내는 오탐이 된다.
    if (raw.includes(key)) out.push(key);
  }
  if (out.length === 0) return [];
  // **반쪽 캡처 방어** — 잡은 토큰으로 설명되지 않는 요일·시간 단어가 남으면 판정을 포기한다.
  // `평일 오전~오후`는 ['평일오전']만, `평일/주말 오전`은 ['주말오전']만 잡혀 '확신에 찬 오판'이 된다:
  // 실제로는 맞는 공고인데 "시간대가 달라요"라는 거짓 문장과 함께 접힌 그룹으로 강등됐다
  // (실측: 슬롯 판정자 250명 중 52~98명). 전부 잡거나(쉼표·중점 나열) 전부 포기(unknown) — 한쪽만 잡지 않는다.
  let rest = raw;
  for (const key of out) rest = rest.split(key).join("");
  if (/평일|주말|매일|오전|오후/.test(rest)) return [];
  return out;
}

export interface PoolFitJob {
  vehicle_required: boolean | null;
  slot: string | null;
}

export interface PoolFitApplicant {
  own_vehicle: string | null;
  work_hours: string | null;
  available_slots: string[] | null;
}

export function judgePoolFit(job: PoolFitJob, applicant: PoolFitApplicant): PoolFitResult {
  const reasons: string[] = [];
  let anyKnown = false;

  // 차량 — 요건이 있고 본인 정보가 '없음'으로 확정일 때만 warn. '미확인'은 warn이 아니다.
  if (job.vehicle_required) {
    const v = normalizeVehicleOwned(applicant.own_vehicle);
    if (v === "없음") {
      reasons.push("본인 차량이 필요한 자리예요 — 등록된 정보에는 차량이 없다고 되어 있어요");
      anyKnown = true;
    } else if (v === "있음") {
      anyKnown = true;
    }
  } else {
    anyKnown = true; // 차량 무관 자리 — 이 축은 항상 맞음
  }

  // 시간대 — 공고에 명시 토큰이 있고, 본인 시간대가 판정됐고, **겹치는 슬롯이 하나도 없을 때만** warn.
  const jobSlots = jobSlotTokens(job.slot);
  if (jobSlots.length > 0) {
    const mine = applicantAvailableSlots({
      work_hours: applicant.work_hours,
      available_slots: applicant.available_slots,
    }).slots;
    if (mine.length > 0) {
      anyKnown = true;
      if (!jobSlots.some((s) => mine.includes(s))) {
        reasons.push("근무 시간대가 알려주신 가능 시간대와 달라요");
      }
    }
  }

  if (reasons.length > 0) return { fit: "warn", reasons };
  return { fit: anyKnown ? "ok" : "unknown", reasons: [] };
}
