import { buildStaffingDateRecommendations, type StaffingDateRecommendation } from "./staffing-date-recommendation.ts";

/** Compares replacements for an explicit manager confirmation; it never changes saved staffing state. */
export function buildStaffingReplacementComparison({ date, today, candidates, snapshots, otherPrimaries, absentApplicantId }:
  Parameters<typeof buildStaffingDateRecommendations>[0] & { absentApplicantId: number | null; today: string }
): { confirmedApplicantIds: number[]; alternatives: StaffingDateRecommendation[] } {
  const validDay = (value: string) => {
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  };
  if (!validDay(date) || !validDay(today) || date < today) return { confirmedApplicantIds: [], alternatives: [] };

  const byApplicant = new Map(snapshots.map((snapshot) => [snapshot.applicant_id, snapshot]));
  const confirmedApplicantIds = candidates.filter((candidate) => {
    const snapshot = byApplicant.get(candidate.applicant_id);
    return snapshot && !snapshot.invalid && snapshot.preparation?.dates.some((day) => day.date === date && day.confirmation === "confirmed");
  }).map((candidate) => candidate.applicant_id);
  const confirmedIds = new Set(confirmedApplicantIds);
  if (absentApplicantId === null || !confirmedIds.has(absentApplicantId)) return { confirmedApplicantIds, alternatives: [] };

  const alternatives = buildStaffingDateRecommendations({ date, snapshots, otherPrimaries,
    candidates: candidates.filter((candidate) => {
      if (confirmedIds.has(candidate.applicant_id) || candidate.agent_stage === "abort") return false;
      const snapshot = byApplicant.get(candidate.applicant_id);
      // Invalid latest data stays visible for review; no earlier revision supplies eligibility.
      if (snapshot?.invalid) return true;
      const preparation = snapshot?.preparation;
      const day = preparation?.dates.find((item) => item.date === date);
      return day?.availability !== "unavailable" && preparation?.training.status !== "on_hold" && preparation?.training.backup_intent !== "declined";
    }),
  });
  return { confirmedApplicantIds, alternatives };
}
