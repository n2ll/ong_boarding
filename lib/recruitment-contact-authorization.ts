import {
  explicitMarketingConsentResponse,
  isExplicitSmsOptOutText,
} from "./sms-consent-policy.ts";

export const RECRUITMENT_CONTACT_AUTHORIZATION_EVENT = "recruitment_contact_authorized";
export const RECRUITMENT_CONTACT_AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000;

export type RecruitmentContactScope = {
  purpose: "new_job";
  batchId: string;
  applicantId: number;
  /** Sender-normalized phone, identical to the stored authorization. */
  phone: string;
  jobIds: number[];
  /** Existing bulkBatchRequestFingerprint: body, subject, purpose and primary job. */
  requestFingerprint: string;
  /** New UI approvals bind the complete recipient set; legacy stored events omit this field. */
  recipientFingerprint?: string;
};

export type RecruitmentContactAuthorizationEvent = {
  id: number;
  applicant_id: number;
  event_type: typeof RECRUITMENT_CONTACT_AUTHORIZATION_EVENT;
  created_at: string;
  meta: {
    basis: "original_recruitment_pool";
    purpose: "new_job";
    batch_id: string;
    applicant_phone: string;
    job_ids: number[];
    request_fingerprint: string;
    recipient_fingerprint?: string;
    confirmed_by: "manager";
    note: string;
    expires_at: string;
  };
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function jobIds(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 3
    && value.every(positiveId) && new Set(value).size === value.length;
}

/**
 * Only call with pool_events read by the server, never client-supplied evidence.
 * This records a manager's original recruitment-purpose basis, not applicant marketing consent.
 * Import provenance, complete refusal history, opt-out and ordinary send guards remain required.
 */
export function recruitmentContactAuthorizationMatches(
  event: unknown,
  scope: RecruitmentContactScope,
  now = new Date(),
): event is RecruitmentContactAuthorizationEvent {
  if (!record(event) || !record(event.meta) || !record(scope)) return false;
  const meta = event.meta;
  if (
    !positiveId(event.id) || !positiveId(scope.applicantId)
    || event.applicant_id !== scope.applicantId
    || event.event_type !== RECRUITMENT_CONTACT_AUTHORIZATION_EVENT
    || scope.purpose !== "new_job" || meta.purpose !== scope.purpose
    || meta.basis !== "original_recruitment_pool" || meta.confirmed_by !== "manager"
    || typeof meta.note !== "string" || meta.note.trim().length < 20
    || typeof scope.batchId !== "string" || !UUID_PATTERN.test(scope.batchId)
    || meta.batch_id !== scope.batchId
    || typeof scope.phone !== "string" || !/^\d{10,11}$/.test(scope.phone)
    || meta.applicant_phone !== scope.phone
    || typeof scope.requestFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(scope.requestFingerprint)
    || meta.request_fingerprint !== scope.requestFingerprint
    || (meta.recipient_fingerprint !== undefined && (typeof scope.recipientFingerprint !== "string"
      || !/^[0-9a-f]{64}$/.test(scope.recipientFingerprint) || meta.recipient_fingerprint !== scope.recipientFingerprint))
    || !jobIds(scope.jobIds) || !jobIds(meta.job_ids)
    || scope.jobIds.length !== meta.job_ids.length
    || !scope.jobIds.every((id) => (meta.job_ids as number[]).includes(id))
    || typeof event.created_at !== "string" || typeof meta.expires_at !== "string"
  ) return false;

  const createdAt = Date.parse(event.created_at);
  const expiresAt = Date.parse(meta.expires_at);
  const nowMs = now.getTime();
  return Number.isFinite(createdAt) && Number.isFinite(expiresAt) && Number.isFinite(nowMs)
    && expiresAt > createdAt
    && expiresAt - createdAt <= RECRUITMENT_CONTACT_AUTHORIZATION_TTL_MS
    && createdAt <= nowMs && nowMs < expiresAt;
}

/** Import provenance is only eligibility for a scoped review; it does not prove consent. */
export function isLegacyRecruitmentPoolImport(applicant: unknown): boolean {
  return record(applicant)
    && (applicant.source === "homepage" || applicant.source === "direct")
    && typeof applicant.airtable_record_id === "string" && applicant.airtable_record_id.trim().length > 0
    && record(applicant.airtable_raw) && Object.keys(applicant.airtable_raw).length > 0
    && (applicant.marketing_consent === false || applicant.marketing_consent === null)
    && applicant.marketing_consent_at === null
    && applicant.sms_opt_out_at === null;
}

/**
 * Supply complete inbound/outbound history for every row sharing the phone number.
 * A historical refusal remains blocking for this legacy path; no manager authorization clears it.
 * Missing/unreadable history blocks. Contextual "아니요" uses the preceding consent question.
 */
export function hasExplicitRecruitmentContactRefusal(history: unknown): boolean {
  if (!Array.isArray(history)) return true;
  const messages: Array<{ direction: string; body: string; at: number }> = [];
  for (const message of history) {
    if (!record(message) || typeof message.body !== "string"
      || typeof message.created_at !== "string"
      || (message.direction !== "inbound" && message.direction !== "outbound")) return true;
    const at = Date.parse(message.created_at);
    if (!Number.isFinite(at)) return true;
    messages.push({ direction: message.direction, body: message.body, at });
  }
  messages.sort((a, b) => a.at - b.at);

  let priorOutboundText: string | null = null;
  for (const message of messages) {
    if (message.direction === "outbound") {
      priorOutboundText = message.body;
    } else {
      // Equal timestamps cannot establish order; consider every possible question at that time.
      const possibleQuestions = [priorOutboundText, ...messages
        .filter((other) => other.direction === "outbound" && other.at === message.at)
        .map((other) => other.body)];
      if (isExplicitSmsOptOutText(message.body) || possibleQuestions.some((question) => (
        explicitMarketingConsentResponse({
          active: true,
          inboundText: message.body,
          priorOutboundText: question,
        }) === false
      ))) return true;
    }
  }
  return false;
}
