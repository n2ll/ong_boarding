import { createHash } from "node:crypto";

export function normalizeTallyVehicleOwnership(value: string): "있음" | "없음" | "" {
  const normalized = value.trim();
  if (normalized === "있음" || normalized === "네" || normalized === "예") return "있음";
  if (normalized === "없음" || normalized === "아니요" || normalized === "아니오") return "없음";
  return "";
}

export function normalizeTallySelfOwnership(value: string): "문제 없음" | "문제 있음" | "" {
  const normalized = value.trim();
  if (normalized === "문제 없음" || normalized.startsWith("네")) return "문제 없음";
  if (normalized === "문제 있음" || normalized.startsWith("아니")) return "문제 있음";
  return "";
}

export function blocksTallyFallback(status: number, errorBody: unknown): boolean {
  if (status === 429 || status === 503) return true;
  if (!errorBody || typeof errorBody !== "object") return false;
  return (errorBody as { code?: unknown }).code === "APPLICATION_ADMISSION_UNAVAILABLE";
}

export function tallySubmissionUuid(input: {
  eventId: string | null;
  formId: string | null;
  responseId: string | null;
  submissionId: string | null;
  rawPayload: string;
}): string {
  const responseKey = input.submissionId?.trim() || input.responseId?.trim();
  const seed = responseKey
    ? `response:${input.formId?.trim() || "unknown-form"}:${responseKey}`
    : input.eventId?.trim()
      ? `event:${input.eventId.trim()}`
      : `payload:${input.rawPayload}`;
  const hex = createHash("sha256").update(`tally:${seed}`).digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
