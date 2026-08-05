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

export interface PoolFitJob {
  vehicle_required: boolean | null;
  /**
   * 시간대 **매칭용 값**(칩으로 고른 4슬롯). 비었으면 시간대는 판정하지 않는다.
   * ⚠️ 사람이 읽는 `jobs.slot`(자유 텍스트 상세 시간)은 **판정에 쓰지 않는다** — 예전에 그 문장을
   *    파싱했고, 반쪽만 잡아 "오후도 되는 공고"를 오후 가능한 분에게 접는 사고가 났다(M4 게이트).
   */
  slot_keys: string[] | null;
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

  // 시간대 — 공고가 칩으로 고른 슬롯이 있고, 본인 시간대가 판정됐고, **겹치는 슬롯이 하나도 없을 때만** warn.
  const jobSlots = (job.slot_keys ?? []).filter((k): k is SlotKey => (SLOTS as readonly string[]).includes(k));
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
