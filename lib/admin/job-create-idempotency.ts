export interface JobCreateAttempt {
  fingerprint: string;
  requestId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function validateJobCreateRequestId(
  value: unknown,
): { ok: true; requestId: string } | { ok: false; reason: "required" | "invalid" } {
  if (value == null || (typeof value === "string" && !value.trim())) {
    return { ok: false, reason: "required" };
  }
  if (typeof value !== "string") return { ok: false, reason: "invalid" };
  const requestId = value.trim();
  return UUID_PATTERN.test(requestId)
    ? { ok: true, requestId }
    : { ok: false, reason: "invalid" };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJsonValue(item) ?? null);
  }
  if (value && typeof value === "object") {
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      const next = canonicalJsonValue((value as Record<string, unknown>)[key]);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  return undefined;
}

/**
 * 요청 키를 제외한 JSON payload를 canonical JSON으로 만든다.
 * 객체 키 순서는 의미가 없고 배열 순서는 요청 데이터이므로 그대로 보존한다.
 */
export function jobCreatePayloadFingerprint(payload: Record<string, unknown>): string {
  const businessPayload = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(payload)) {
    if (key !== "client_request_id") businessPayload[key] = value;
  }
  return JSON.stringify(canonicalJsonValue(businessPayload));
}

/** DB에는 공고 본문 원문 대신 고정 길이 SHA-256만 보존한다. */
export async function jobCreatePayloadDigest(payload: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(jobCreatePayloadFingerprint(payload));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 열린 폼 하나는 내용이 바뀌어도 같은 UUID를 유지한다. 회전은 호출부가 current를 비울 때만 일어난다. */
export function nextJobCreateAttempt(
  current: JobCreateAttempt | null,
  payload: Record<string, unknown>,
  createRequestId: () => string,
): JobCreateAttempt {
  if (current) return current;
  const fingerprint = jobCreatePayloadFingerprint(payload);
  return { fingerprint, requestId: createRequestId() };
}

/** 같은 키의 기존 행은 유효한 SHA-256이 정확히 일치할 때만 replay한다. */
export function jobCreateReplayDecision(
  existingFingerprint: string | null | undefined,
  requestFingerprint: string,
): "replay" | "conflict" {
  if (!existingFingerprint || !SHA256_HEX_PATTERN.test(existingFingerprint)) return "conflict";
  if (!SHA256_HEX_PATTERN.test(requestFingerprint)) return "conflict";
  return existingFingerprint === requestFingerprint ? "replay" : "conflict";
}
