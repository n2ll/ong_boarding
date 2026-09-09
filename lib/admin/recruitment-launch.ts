export type RecruitmentTarget = { applicant_id: number; name: string; phone: string };
export type RecruitmentRecipient = Pick<RecruitmentTarget, "applicant_id" | "phone">;
export type RecruitmentReview = {
  reviewed_at: string;
  expires_at?: string;
  recipients: Array<RecruitmentTarget & { state: "consented" | "authorization_required" | "authorized" | "blocked"; reason?: string }>;
};
export type RecruitmentSendResult = RecruitmentRecipient & { state: "recorded" | "attention" | "failed" | "blocked"; reason: string };
const phone = (value: string) => value.replace(/\D/g, "");
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Incomplete or changed identities must never become an approved send list. */
export function parseRecruitmentReview(value: unknown, targets: RecruitmentTarget[]): RecruitmentReview | null {
  if (!record(value) || typeof value.reviewed_at !== "string" || !Number.isFinite(Date.parse(value.reviewed_at))
    || !Array.isArray(value.recipients) || value.recipients.length !== targets.length) return null;
  const seen = new Set<number>();
  for (const row of value.recipients) {
    if (!record(row) || typeof row.applicant_id !== "number" || seen.has(row.applicant_id)
      || typeof row.phone !== "string" || typeof row.name !== "string"
      || !["consented", "authorization_required", "authorized", "blocked"].includes(String(row.state))) return null;
    const target = targets.find(item => item.applicant_id === row.applicant_id);
    if (!target || phone(target.phone) !== phone(row.phone)) return null;
    seen.add(row.applicant_id);
  }
  return value as RecruitmentReview;
}

export function recruitmentSendRecipients(review: RecruitmentReview): RecruitmentRecipient[] {
  return review.recipients.filter(row => row.state === "consented" || row.state === "authorized")
    .map(row => ({ applicant_id: row.applicant_id, phone: phone(row.phone) }));
}

export function recruitmentSendResults(value: unknown, recipients: RecruitmentRecipient[]): RecruitmentSendResult[] {
  const uncertain = () => recipients.map(row => ({ ...row, state: "attention" as const, reason: "발송 결과 확인 필요 · 재발송하지 마세요" }));
  if (!record(value) || !Array.isArray(value.results) || value.results.length !== recipients.length) return uncertain();
  const results: RecruitmentSendResult[] = [];
  const seen = new Set<number>();
  for (const row of value.results) {
    if (!record(row) || typeof row.applicant_id !== "number" || seen.has(row.applicant_id) || typeof row.phone !== "string"
      || typeof row.success !== "boolean" || !["recorded", "sent_unrecorded", "unknown", "failed", "blocked", "conflict"].includes(String(row.state))) return uncertain();
    const target = recipients.find(item => item.applicant_id === row.applicant_id);
    if (!target || phone(target.phone) !== phone(row.phone)) return uncertain();
    seen.add(row.applicant_id);
    const state = row.success && row.state === "recorded" && row.recovery_pending !== true ? "recorded"
      : row.state === "failed" ? "failed" : row.state === "blocked" || row.state === "conflict" ? "blocked" : "attention";
    results.push({ ...target, state, reason: typeof row.error === "string" ? row.error : state === "recorded" ? "발송 기록 완료" : "발송 결과 확인 필요" });
  }
  return results;
}

export function recruitmentPilotTargets<T extends { id: number; job_ids: number[] }>(targets: T[], scope: { jobId: number; applicantIds: number[] }): T[] {
  return targets.filter(target => scope.applicantIds.includes(target.id) && target.job_ids.includes(scope.jobId));
}
