import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { ipAddress as vercelIpAddress } from "@vercel/functions";

export const APPLICATION_INTERNAL_HEADER = "x-ongboarding-apply-internal";

export type ApplicationAdmissionResult =
  | { kind: "admitted" | "replay" }
  | { kind: "conflict" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "error" };

export function applicationRateLimitHash(
  namespace: "phone" | "ip",
  value: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`apply-rate-limit:v1:${namespace}\0${value}`)
    .digest("hex");
}

export function applicationInternalSignature(input: {
  submissionId: string;
  requestFingerprint: string;
  secret: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(`apply-internal:tally:v1\0${input.submissionId}\0${input.requestFingerprint}`)
    .digest("hex");
}

export function isTrustedApplicationInternalRequest(input: {
  source: unknown;
  submissionId: string;
  requestFingerprint: string;
  providedSignature: string | null;
  secret: string | null;
}): boolean {
  if (
    input.source !== "homepage"
    || !input.secret
    || !input.providedSignature
    || !/^[0-9a-f]{64}$/i.test(input.providedSignature)
  ) {
    return false;
  }

  const expected = applicationInternalSignature({
    submissionId: input.submissionId,
    requestFingerprint: input.requestFingerprint,
    secret: input.secret,
  });
  const providedBuffer = Buffer.from(input.providedSignature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function trustedApplicationClientIp(
  request: {
    ip?: unknown;
    headers: { get(name: string): string | null };
  },
  isVercel: boolean,
): string | null {
  if (typeof request.ip === "string" && isIP(request.ip.trim()) !== 0) {
    return request.ip.trim();
  }
  if (!isVercel) return null;

  // Vercel 공식 helper가 해석하는 platform signal만 사용한다.
  // 일반 x-forwarded-for 등 클라이언트가 보낼 수 있는 헤더는 직접 읽지 않는다.
  const candidate = vercelIpAddress(request.headers as Headers)?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : null;
}

export async function claimApplicationSubmissionAdmission(
  claim: () => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<ApplicationAdmissionResult> {
  let response: { data: unknown; error: unknown };
  try {
    response = await claim();
  } catch {
    return { kind: "error" };
  }
  if (response.error) return { kind: "error" };

  const raw = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!raw || typeof raw !== "object") return { kind: "error" };
  const row = raw as { outcome?: unknown; retry_after_seconds?: unknown };
  if (row.outcome === "admitted" || row.outcome === "replay") {
    return { kind: row.outcome };
  }
  if (row.outcome === "conflict") return { kind: "conflict" };
  if (row.outcome !== "rate_limited") return { kind: "error" };

  const retryAfterSeconds = Number(row.retry_after_seconds);
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 1) {
    return { kind: "error" };
  }
  return { kind: "rate_limited", retryAfterSeconds: Math.ceil(retryAfterSeconds) };
}
