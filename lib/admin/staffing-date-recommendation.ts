import type { StaffingPreparationSnapshot, StaffingPrimaryCandidate } from "./staffing-preparation.ts";

type StaffingDateRecommendationCandidate = {
  applicant_id: number;
  agent_stage?: string | null;
  applicants?: { own_vehicle: string | null } | null;
};
export type StaffingDateRecommendation = {
  applicant_id: number;
  /** Review priority, not a suitability score. Equal ranks retain the input order. */
  rank: number;
  label: string;
  reasons: string[];
};

/** Uses only the current job's latest manager snapshots; history and participation never imply readiness. */
export function buildStaffingDateRecommendations({ date, candidates, snapshots, otherPrimaries }: {
  date: string;
  candidates: readonly StaffingDateRecommendationCandidate[];
  snapshots: readonly StaffingPreparationSnapshot[];
  otherPrimaries: readonly StaffingPrimaryCandidate[];
}): StaffingDateRecommendation[] {
  const byApplicant = new Map(snapshots.map((snapshot) => [snapshot.applicant_id, snapshot]));
  const otherAssignments = new Set(otherPrimaries.filter((other) => other.date === date).map((other) => other.applicant_id));
  return candidates.map((candidate): StaffingDateRecommendation => {
    const snapshot = byApplicant.get(candidate.applicant_id);
    const preparation = snapshot?.preparation;
    const day = preparation?.dates.find((item) => item.date === date);
    const training = preparation?.training;
    const duplicate = otherAssignments.has(candidate.applicant_id);
    const holdReasons = [
      ...(day?.availability === "unavailable" ? ["선택일 불가"] : []),
      ...(training?.status === "on_hold" ? ["선탑 보류"] : []),
      ...(training?.backup_intent === "declined" ? ["본인 진행 안 함"] : []),
      ...(candidate.agent_stage === "abort" ? ["후보 진행 중단"] : []),
    ];
    let rank: number;
    let label: string;
    let reasons: string[];
    if (snapshot?.invalid) {
      rank = 4; label = "기록 확인 필요";
      reasons = ["최신 진행 기록 확인 필요", "가능 여부 판단 보류"];
    } else if (day?.confirmation === "confirmed") {
      rank = 6; label = "투입 확정";
      const reviewReasons = [
        ...(duplicate ? ["다른 라인 본담당 후보 · 운행·반납 시간 확인 필요"] : []),
        ...(holdReasons.length ? [`${holdReasons.join(" · ")} · 관리자 재확인`] : []),
      ];
      reasons = ["선택일 투입 확정 기록", reviewReasons.join(" · ") || "추가 충원 검토 대상 아님"];
    } else if (holdReasons.length) {
      rank = 5; label = "연락 보류";
      reasons = [holdReasons.join(" · "), "연락 재개 여부는 관리자 확인"];
    } else if (duplicate) {
      rank = 3; label = "중복 일정 확인";
      reasons = ["같은 날짜 다른 라인 본담당 후보", "운행·반납 시간 확인 필요"];
    } else {
      const available = day?.availability === "available";
      const completed = training?.status === "completed";
      const interested = training?.backup_intent === "interested";
      rank = available ? completed && interested ? 0 : 1 : 2;
      label = rank === 0 ? "우선 검토" : available ? "가능일 확인됨" : "가능 여부 확인";
      reasons = [available ? "선택일 가능 기록" : "선택일 가능 여부 미확인",
        `${completed ? "선탑 완료" : "선탑 완료 여부 확인"} · ${interested ? "본인 진행 희망" : "본인 의사 확인"}`];
    }
    const vehicle = candidate.applicants?.own_vehicle;
    if (vehicle !== "있음" && vehicle !== "없음") reasons.push("차량 미확인");
    return { applicant_id: candidate.applicant_id, rank, label, reasons };
  }).sort((a, b) => a.rank - b.rank);
}
