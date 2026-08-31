import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "../ongmanaging.ts";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";

export interface PhoneMessageIdentityRow {
  id: number;
  phone: string | null;
  marketing_consent: boolean | null;
  marketing_consent_at: string | null;
  sms_opt_out_at: string | null;
  status: string | null;
  current_job_id: number | null;
}

export interface PhoneMessageIdentity {
  applicantIds: number[];
  hasActiveSmsOptOut: boolean;
  applicantStatuses: string[];
  currentJobIds: number[];
}

export interface PhoneMessageIdentityIndex {
  byPhone: Map<string, PhoneMessageIdentity>;
  phoneByApplicantId: Map<number, string>;
}

type MutablePhoneMessageIdentity = {
  applicantIds: number[];
  latestConsentMs: number | null;
  latestOptOutMs: number | null;
  hasUnorderedOptOut: boolean;
  applicantStatuses: string[];
  currentJobIds: number[];
};

function parsedTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 중복 지원자 행을 전화번호 한 사람으로 묶는다.
 *
 * 공개 지원·문자 재동의는 marketing_consent_at을 갱신하며 기존 수신거부를 해제한다.
 * 따라서 전화번호 전체에서 가장 최신인 명시적 재동의가 수신거부보다 **엄격히 뒤**일 때만
 * 과거 opt-out을 해제한다. 시각을 비교할 수 없는 opt-out은 안전하게 계속 차단한다.
 */
export function buildPhoneMessageIdentityIndex(
  rows: PhoneMessageIdentityRow[],
): PhoneMessageIdentityIndex {
  const mutableByPhone = new Map<string, MutablePhoneMessageIdentity>();
  const phoneByApplicantId = new Map<number, string>();

  for (const row of rows) {
    const phone = normalizePhone(row.phone ?? "");
    if (!phone) continue;

    phoneByApplicantId.set(row.id, phone);
    let identity = mutableByPhone.get(phone);
    if (!identity) {
      identity = {
        applicantIds: [],
        latestConsentMs: null,
        latestOptOutMs: null,
        hasUnorderedOptOut: false,
        applicantStatuses: [],
        currentJobIds: [],
      };
      mutableByPhone.set(phone, identity);
    }
    identity.applicantIds.push(row.id);
    if (row.status && !identity.applicantStatuses.includes(row.status)) {
      identity.applicantStatuses.push(row.status);
    }
    if (typeof row.current_job_id === "number" && !identity.currentJobIds.includes(row.current_job_id)) {
      identity.currentJobIds.push(row.current_job_id);
    }

    if (row.marketing_consent === true && row.marketing_consent_at) {
      const consentMs = parsedTimestamp(row.marketing_consent_at);
      if (consentMs !== null && (identity.latestConsentMs === null || consentMs > identity.latestConsentMs)) {
        identity.latestConsentMs = consentMs;
      }
    }

    if (row.sms_opt_out_at) {
      const optOutMs = parsedTimestamp(row.sms_opt_out_at);
      if (optOutMs === null) {
        identity.hasUnorderedOptOut = true;
      } else if (identity.latestOptOutMs === null || optOutMs > identity.latestOptOutMs) {
        identity.latestOptOutMs = optOutMs;
      }
    }
  }

  const byPhone = new Map<string, PhoneMessageIdentity>();
  for (const [phone, identity] of mutableByPhone) {
    const hasTimestampedOptOut = identity.latestOptOutMs !== null;
    const hasLaterConsent = hasTimestampedOptOut
      && identity.latestConsentMs !== null
      && identity.latestConsentMs > identity.latestOptOutMs!;
    byPhone.set(phone, {
      applicantIds: identity.applicantIds,
      hasActiveSmsOptOut: identity.hasUnorderedOptOut || (hasTimestampedOptOut && !hasLaterConsent),
      applicantStatuses: identity.applicantStatuses,
      currentJobIds: identity.currentJobIds,
    });
  }

  return { byPhone, phoneByApplicantId };
}

/** 전체 지원자 원장을 페이지 단위로 읽어 전화번호 단위 발송 정책 인덱스를 만든다. */
export async function fetchPhoneMessageIdentityIndex(
  supabase: SupabaseClient,
): Promise<PhoneMessageIdentityIndex> {
  const rows = await fetchAllPostgrestRows(async (from, to) => {
    const result = await supabase
      .from("applicants")
      .select("id, phone, marketing_consent, marketing_consent_at, sms_opt_out_at, status, current_job_id")
      .order("id", { ascending: true })
      .range(from, to);
    return {
      data: result.data as PhoneMessageIdentityRow[] | null,
      error: result.error,
    };
  }, "전화번호별 문자 수신 상태");

  return buildPhoneMessageIdentityIndex(rows);
}
