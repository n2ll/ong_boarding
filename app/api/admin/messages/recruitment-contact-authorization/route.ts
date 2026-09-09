import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { fetchAllPostgrestRows } from "@/lib/admin/postgrest-pagination";
import { fetchPhoneMessageIdentityIndex } from "@/lib/admin/phone-message-identity";
import { normalizePhone } from "@/lib/ongmanaging";
import { isJobEffectivelyClosed } from "@/lib/jobs";
import { isGeneralLineJob, joinedClientType } from "@/lib/agent/general-line";
import { detectConfirmationNuance } from "@/lib/agent/outbound-safety";
import { bulkBatchRequestFingerprint, bulkRecruitmentRecipientFingerprint, validateBulkRequestId } from "@/lib/bulk-message-send";
import {
  hasExplicitRecruitmentContactRefusal, isLegacyRecruitmentPoolImport,
  recruitmentContactAuthorizationMatches, RECRUITMENT_CONTACT_AUTHORIZATION_EVENT,
  RECRUITMENT_CONTACT_AUTHORIZATION_TTL_MS,
} from "@/lib/recruitment-contact-authorization";

export const dynamic = "force-dynamic";

type Recipient = { applicant_id: number; phone: string };
type ReviewedRecipient = Recipient & {
  name: string;
  state: "consented" | "authorization_required" | "authorized" | "blocked";
  reason?: string;
};
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** 원장 질문의 제목이나 일반 지역명만으로 비마트 관계를 추정하지 않는다. */
function hasBmartMarker(value: unknown): boolean {
  if (typeof value === "string") return /비마트|b마트|bmart|baemin_bmart|배민/i.test(value)
    && !/없음|없어요|없습니다|아니요|해당\s*없|무관/.test(value);
  if (Array.isArray(value)) return value.some(hasBmartMarker);
  return record(value) && Object.values(value).some(hasBmartMarker);
}

/** All inserts share one batch key, including disjoint recipient races. PostgreSQL inserts the array atomically. */
function actionKey(batchId: string, suffix: string): string {
  const hex = crypto.createHash("md5").update(`recruitment-contact:${batchId}:${suffix}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function POST(req: NextRequest) {
  let input: unknown;
  try { input = await req.json(); } catch { return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 }); }
  if (!record(input)) return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  const data = input;
  const batch = validateBulkRequestId(data.bulk_request_id);
  const body = typeof data.body === "string" ? data.body.trim() : "";
  const subject = typeof data.subject === "string" && data.subject ? data.subject.trim() : "옹고잉 채용 안내";
  const note = typeof data.note === "string" ? data.note.trim() : "";
  const jobIds = data.recruitment_job_ids;
  if (!batch.ok || (data.mode !== "review" && data.mode !== "authorize") || data.purpose !== "new_job"
    || !positiveId(data.job_id) || !Array.isArray(jobIds) || jobIds.length < 1 || jobIds.length > 3
    || !jobIds.every(positiveId) || new Set(jobIds).size !== jobIds.length || !jobIds.includes(data.job_id)
    || (data.subject !== undefined && typeof data.subject !== "string")
    || !body || !body.includes("#{맞춤링크}") || detectConfirmationNuance(body)
    || !Array.isArray(data.recipients) || data.recipients.length < 1 || data.recipients.length > 50
    || (data.mode === "authorize" && (note.length < 20 || note.length > 2000))) {
    return NextResponse.json({ error: "공고·대상·본문·배치와 모집 연락 근거를 확인해 주세요." }, { status: 400 });
  }
  const recipients: Recipient[] = [];
  for (const row of data.recipients) {
    if (!record(row) || !positiveId(row.applicant_id) || typeof row.phone !== "string") {
      return NextResponse.json({ error: "대상 정보가 올바르지 않습니다." }, { status: 400 });
    }
    const phone = normalizePhone(row.phone);
    if (!/^\d{10,11}$/.test(phone) || recipients.some(r => r.applicant_id === row.applicant_id || r.phone === phone)) {
      return NextResponse.json({ error: "중복되거나 잘못된 전화번호가 있습니다." }, { status: 400 });
    }
    recipients.push({ applicant_id: row.applicant_id, phone });
  }
  const batchId = batch.key;
  const primaryJobId = data.job_id;
  const requestFingerprint = bulkBatchRequestFingerprint({ body, subject, purpose: "new_job", jobId: primaryJobId });
  const recipientFingerprint = bulkRecruitmentRecipientFingerprint(recipients);
  const now = new Date(Date.now());
  const supabase = createServiceClient();
  const readEvents = () => fetchAllPostgrestRows(async (from, to) => {
    const result = await supabase.from("pool_events").select("id, applicant_id, event_type, created_at, meta")
      .eq("event_type", RECRUITMENT_CONTACT_AUTHORIZATION_EVENT).eq("meta->>batch_id", batchId)
      .order("id", { ascending: true }).range(from, to);
    return { data: result.data, error: result.error };
  }, "모집 연락 근거");
  try {
    const [jobs, identityIndex, blacklist, existing] = await Promise.all([
      fetchAllPostgrestRows(async (from, to) => {
        const result = await supabase.from("jobs").select("id, title, status, closes_at, recruit_mode, exposure, client:clients ( client_type )")
          .in("id", jobIds).order("id", { ascending: true }).range(from, to);
        return { data: result.data, error: result.error };
      }, "모집 공고"),
      fetchPhoneMessageIdentityIndex(supabase),
      fetchAllPostgrestRows(async (from, to) => {
        const result = await supabase.from("recruitment_blacklist").select("phone").order("phone", { ascending: true }).range(from, to);
        return { data: result.data, error: result.error };
      }, "재채용 제외 명단"),
      readEvents(),
    ]);
    if (jobs.length !== jobIds.length || jobs.some(job => !job.title?.trim()
      || !isGeneralLineJob({ title: job.title, client_type: joinedClientType(job.client) })
      || job.recruit_mode !== "internal" || job.exposure !== "targeted"
      || isJobEffectivelyClosed(job.status, job.closes_at))) {
      return NextResponse.json({ error: "진행 중인 일반 배송 내부 지정 공고만 검토할 수 있습니다." }, { status: 409 });
    }
    const requestedIds = recipients.map(row => row.applicant_id);
    const identityIds = [...new Set(recipients.flatMap(row => identityIndex.byPhone.get(row.phone)?.applicantIds ?? []).concat(requestedIds))];
    const [applicants, candidates, exposures, messages] = await Promise.all([
      fetchAllPostgrestRows(async (from, to) => {
        const result = await supabase.from("applicants")
          .select("id, name, phone, source, baemin_id, marketing_consent, marketing_consent_at, sms_opt_out_at, airtable_record_id, airtable_raw, status, current_job_id, access_token")
          .in("id", identityIds).order("id", { ascending: true }).range(from, to);
        return { data: result.data, error: result.error };
      }, "대상 모집 원장"),
      fetchAllPostgrestRows(async (from, to) => {
        const result = await supabase.from("job_candidates").select("id, applicant_id")
          .in("applicant_id", identityIds).order("id", { ascending: true }).range(from, to);
        return { data: result.data, error: result.error };
      }, "기존 공고 후보"),
      fetchAllPostgrestRows(async (from, to) => {
        const result = await supabase.from("job_exposure_targets").select("job_id, applicant_id, mode")
          .in("job_id", jobIds).in("applicant_id", requestedIds).order("job_id", { ascending: true }).order("applicant_id", { ascending: true }).range(from, to);
        return { data: result.data, error: result.error };
      }, "공고 노출 대상"),
      fetchAllPostgrestRows(async (from, to) => {
        const result = await supabase.from("messages").select("id, applicant_id, direction, body, created_at")
          .in("applicant_id", identityIds).order("id", { ascending: true }).range(from, to);
        return { data: result.data, error: result.error };
      }, "모집 연락 거절 이력"),
    ]);
    const blockedPhones = new Set(blacklist.map(row => normalizePhone(row.phone ?? "")));
    const reviewed: ReviewedRecipient[] = recipients.map(recipient => {
      const applicant = applicants.find(row => row.id === recipient.applicant_id);
      const identity = identityIndex.byPhone.get(recipient.phone);
      const duplicates = applicants.filter(row => identity?.applicantIds.includes(row.id));
      let reason: string | undefined;
      if (!applicant || normalizePhone(applicant.phone ?? "") !== recipient.phone || !identity?.applicantIds.includes(recipient.applicant_id)
        || duplicates.length !== identity.applicantIds.length) reason = "서버 원장과 대상 전화번호가 일치하지 않습니다.";
      else if (identity.hasActiveSmsOptOut || applicant.sms_opt_out_at) reason = "수신 거부가 기록되어 있습니다.";
      else if (blockedPhones.has(recipient.phone)) reason = "재채용 제외 대상입니다.";
      else if (duplicates.some(row => row.source === "baemin" || !!row.baemin_id
        || hasBmartMarker(row.airtable_raw))) reason = "비마트 관련 모집 이력이 있습니다.";
      else if (identity.applicantStatuses.some(status => ["부적합", "이탈", "인력풀 제외", "확정인력"].includes(status))) reason = "현재 인력풀 상태상 모집 안내 대상이 아닙니다.";
      else if (identity.currentJobIds.length || candidates.some(row => identity.applicantIds.includes(row.applicant_id))) reason = "기존 공고 후보 관계가 있어 이번 신규 모집 대상에서 제외합니다.";
      else if (!applicant.access_token) reason = "맞춤 공고 링크가 없습니다.";
      else if (!jobIds.every(jobId => {
        const rows = exposures.filter(row => row.job_id === jobId && row.applicant_id === recipient.applicant_id);
        return rows.length === 1 && rows[0].mode === "include";
      })) reason = "모든 모집 공고의 지정 노출 대상이어야 합니다.";
      else if (applicant.marketing_consent !== true && !isLegacyRecruitmentPoolImport(applicant)) reason = "기존 모집 설문 원장을 확인할 수 없습니다.";
      else if (applicant.marketing_consent !== true && hasExplicitRecruitmentContactRefusal(messages.filter(row => identity.applicantIds.includes(row.applicant_id)))) reason = "이전 문자에서 명시적으로 연락을 거절했습니다.";
      return { ...recipient, name: applicant?.name ?? "이름 미등록",
        state: reason ? "blocked" : applicant?.marketing_consent === true ? "consented" : "authorization_required", ...(reason ? { reason } : {}) };
    });
    const legacy = reviewed.filter(row => row.state === "authorization_required");
    const matches = (events: typeof existing) => events.length === legacy.length && legacy.every(recipient => events.filter(event =>
      event.meta?.recipient_fingerprint === recipientFingerprint && recruitmentContactAuthorizationMatches(event, {
        purpose: "new_job", batchId, applicantId: recipient.applicant_id, phone: recipient.phone,
        jobIds, requestFingerprint, recipientFingerprint,
      }, new Date(Date.now()))).length === 1);
    if (existing.length && !matches(existing)) {
      return NextResponse.json({ error: "기존 승인과 대상·본문·공고가 다르거나 승인이 만료됐습니다. 새 배치로 다시 검토해 주세요." }, { status: 409 });
    }
    let events = existing;
    if (data.mode === "authorize") {
      if (reviewed.some(row => row.state === "blocked")) {
        return NextResponse.json({ error: "제외 대상을 뺀 새 배치로 다시 검토해 주세요.", recipients: reviewed }, { status: 409 });
      }
      if (!events.length && legacy.length) {
        const expiresAt = new Date(now.getTime() + RECRUITMENT_CONTACT_AUTHORIZATION_TTL_MS).toISOString();
        const rows = [...legacy].sort((a, b) => a.applicant_id - b.applicant_id).map((recipient, index) => ({
          applicant_id: recipient.applicant_id, job_id: primaryJobId, event_type: RECRUITMENT_CONTACT_AUTHORIZATION_EVENT,
          created_at: now.toISOString(), action_key: actionKey(batchId, index === 0 ? "batch" : String(recipient.applicant_id)),
          meta: { basis: "original_recruitment_pool", purpose: "new_job", batch_id: batchId,
            applicant_phone: recipient.phone, job_ids: jobIds, request_fingerprint: requestFingerprint,
            recipient_fingerprint: recipientFingerprint, confirmed_by: "manager", note, expires_at: expiresAt },
        }));
        const inserted = await supabase.from("pool_events").insert(rows).select("id, applicant_id, event_type, created_at, meta");
        if (inserted.error?.code === "23505") {
          events = await readEvents();
          if (!matches(events)) return NextResponse.json({ error: "같은 배치의 다른 승인이 이미 저장됐습니다. 새 배치로 검토해 주세요." }, { status: 409 });
        } else if (inserted.error || !Array.isArray(inserted.data) || !matches(inserted.data)) {
          throw new Error("승인 기록 저장 결과를 확인하지 못했습니다.");
        } else events = inserted.data;
      }
    }
    if (events.length) for (const recipient of legacy) recipient.state = "authorized";
    return NextResponse.json({ bulk_request_id: batchId, reviewed_at: now.toISOString(),
      ...(events.length ? { expires_at: events[0].meta.expires_at } : {}), recipients: reviewed });
  } catch (error) {
    console.error("[recruitment-contact-authorization] verification failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "모집 연락 근거를 안전하게 확인하거나 저장하지 못했습니다. 새로 검토해 주세요." }, { status: 503 });
  }
}
