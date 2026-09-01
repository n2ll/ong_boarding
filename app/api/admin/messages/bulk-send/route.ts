import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { sendSms } from "@/lib/solapi";
import { fetchBlacklistedPhones } from "@/lib/blacklist";
import {
  CURRENT_JOB_WAITLIST_SMS_BODY,
  classifyBulkSmsCategory,
  currentJobClosedSmsBody,
  smsRecipientBlockReason,
} from "@/lib/sms-consent-policy";
import { isGeneralLineJob, joinedClientType } from "@/lib/agent/general-line";
import { isJobEffectivelyClosed } from "@/lib/jobs";
import { fetchAllPostgrestRows } from "@/lib/admin/postgrest-pagination";
import {
  fetchPhoneMessageIdentityIndex,
  type PhoneMessageIdentityIndex,
} from "@/lib/admin/phone-message-identity";
import { normalizePhone } from "@/lib/ongmanaging";
import {
  isExposed,
  normalizeRule,
  type ExposureApplicant,
  type ExposureMode,
} from "@/lib/exposure";
import { EXPOSURE_JOB_GEO_COLUMNS, type GeoJob } from "@/lib/geo";
import { detectConfirmationNuance } from "@/lib/agent/outbound-safety";
import {
  bulkBatchRequestFingerprint,
  bulkMessageRequestFingerprint,
  bulkRecipientIdempotencyKey,
  deliverBulkMessage,
  validateBulkRequestId,
  type BulkMessageOutboxStatus,
} from "@/lib/bulk-message-send";

export const dynamic = "force-dynamic";
// 한 요청이 최대 50명에게 순차 발송한다 — 기본 제한(10s/60s)으로는 중간에 끊겨
// '일부만 나갔는데 실패로 보이는' 상태가 된다. 발송 루프에 맞춰 넉넉히 잡는다.
export const maxDuration = 300;
const APPLICANT_ID_BATCH_SIZE = 250;

interface Recipient {
  phone: string;
  applicant_id?: number | null;
}

interface BulkSendBody {
  recipients: Recipient[];
  body: string;
  subject?: string;
  bulk_request_id?: unknown;
  // 발송 목적 태그(선택) — ping_sent meta에 기록해 발송 이력을 추적 (예: 'waitlist' 대기 안내).
  purpose?: string;
  // purpose와 연관된 공고 id(선택) — 예: '공고 관심자 선택'으로 고른 대기 안내 대상의 공고.
  job_id?: number;
}

interface MessageApplicant extends ExposureApplicant {
  name: string | null;
  phone: string | null;
  access_token: string | null;
  sms_opt_out_at: string | null;
  marketing_consent: boolean | null;
  status: string | null;
}

type NewJobAnnouncement = {
  exposure_rule?: unknown;
} & GeoJob;

type BulkSendResult = {
  applicant_id?: number | null;
  phone: string;
  success: boolean;
  error?: string;
  delivery?: "sent" | "unknown" | "not_sent";
  state?: "recorded" | "sent_unrecorded" | "unknown" | "failed" | "blocked" | "conflict";
  recorded?: boolean;
  deduplicated?: boolean;
  recovery_pending?: boolean;
};

const BULK_OUTBOX_STATUSES = new Set<BulkMessageOutboxStatus>([
  "sending",
  "unknown",
  "failed",
  "sent",
  "recorded",
]);
const BULK_SMS_PROVIDER_TIMEOUT_MS = 5_000;

function bulkGuardReasonMessage(reason: unknown): string {
  if (reason === "recent_new_job") return "최근 7일 내 새 공고 안내 수신(중복 방지)";
  if (reason === "recent_job_notice") return "24시간 내 공고 안내 수신(중복 방지)";
  if (reason === "recent_bulk") return "최근 발송됨(중복 방지)";
  if (reason === "same_intent_active") return "동일한 발송 요청이 처리 중입니다(재발송 제외)";
  if (reason === "concurrent_claim") return "동시 발송 요청 감지(중복 방지)";
  return "발송 간격 보호로 문자를 보내지 않았습니다.";
}

export async function POST(req: NextRequest) {
  try {
    const data = (await req.json()) as BulkSendBody;
    const text = (data.body || "").trim();
    // LMS 제목 — 미지정 시 SOLAPI가 본문 첫 문장을 제목으로 자동 생성해 인사말이 중복 노출된다.
    const subject = (data.subject || "옹고잉 채용 안내").trim();
    const recipients = Array.isArray(data.recipients) ? data.recipients : [];
    // 발송 목적 태그 — ping_sent meta 기록용(예: waitlist). 임의 문자열 유입 대비 길이 제한.
    const purpose = typeof data.purpose === "string" ? data.purpose.trim().slice(0, 40) : "";
    const purposeJobId =
      typeof data.job_id === "number" && Number.isFinite(data.job_id) ? data.job_id : null;

    if (!text) {
      return NextResponse.json({ error: "메시지 내용이 비어있습니다." }, { status: 400 });
    }
    if (recipients.length === 0) {
      return NextResponse.json({ error: "수신자가 없습니다." }, { status: 400 });
    }
    if (recipients.length > 50) {
      return NextResponse.json(
        { error: "한 번에 최대 50명까지 발송 가능합니다." },
        { status: 400 }
      );
    }
    const validatedRequestId = validateBulkRequestId(data.bulk_request_id);
    if (!validatedRequestId.ok) {
      return NextResponse.json(
        {
          error: validatedRequestId.reason === "required"
            ? "발송 요청 키가 필요합니다. 화면을 새로고침한 뒤 다시 시도해주세요."
            : "유효하지 않은 발송 요청 키입니다.",
        },
        { status: 400 },
      );
    }
    const bulkRequestId = validatedRequestId.key;

    const requestedCategory = classifyBulkSmsCategory({ purpose, body: text });
    if (requestedCategory === "unknown") {
      return NextResponse.json({ error: "알 수 없는 발송 목적입니다." }, { status: 400 });
    }
    // 새 공고 안내는 지원자가 링크에서 조건을 직접 확인하는 흐름이다. 직접 API 호출도
    // 맞춤 링크를 빼거나 배정·확정처럼 오해할 문구를 우회 발송하지 못하게 서버에서 막는다.
    if (purpose === "new_job" && !text.includes("#{맞춤링크}")) {
      return NextResponse.json(
        { error: "새 공고 안내에는 #{맞춤링크} 치환자가 필요합니다." },
        { status: 400 },
      );
    }
    if (purpose === "new_job" && detectConfirmationNuance(text)) {
      return NextResponse.json(
        { error: "새 공고 안내에는 배정·근무 확정으로 오해할 문구를 사용할 수 없습니다." },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();
    const results: BulkSendResult[] = [];
    let newJobIsTargeted = false;
    let newJobAnnouncement: NewJobAnnouncement | null = null;
    const newJobExposureOverrides = new Map<number, ExposureMode>();

    // 새 공고 안내 대상 모달을 오래 열어둔 사이 공고가 마감되거나 모집 채널이 바뀔 수 있다.
    // 클라이언트가 산정한 대상을 신뢰하지 않고 실제 발송 직전에 pull(/p) 노출 가능 상태를 재확인한다.
    if (purpose === "new_job") {
      if (purposeJobId === null || !Number.isSafeInteger(purposeJobId) || purposeJobId <= 0) {
        return NextResponse.json({ error: "안내할 공고를 확인할 수 없습니다." }, { status: 400 });
      }
      const { data: announcementJob, error: announcementJobError } = await supabase
        .from("jobs")
        .select(`status, closes_at, recruit_mode, exposure, exposure_rule, ${EXPOSURE_JOB_GEO_COLUMNS}`)
        .eq("id", purposeJobId)
        .maybeSingle();
      if (announcementJobError) {
        console.error("[bulk-send] new-job lookup failed", announcementJobError);
        return NextResponse.json({ error: "안내할 공고 상태를 확인하지 못했습니다." }, { status: 503 });
      }
      if (!announcementJob) {
        return NextResponse.json({ error: "안내할 공고를 찾을 수 없습니다." }, { status: 404 });
      }
      if (announcementJob.recruit_mode !== "internal" && announcementJob.recruit_mode !== "both") {
        return NextResponse.json(
          { error: "인력풀에 노출되지 않는 공고는 안내할 수 없습니다." },
          { status: 409 },
        );
      }
      if (isJobEffectivelyClosed(announcementJob.status, announcementJob.closes_at)) {
        return NextResponse.json({ error: "마감된 공고는 안내할 수 없습니다." }, { status: 409 });
      }
      newJobIsTargeted = announcementJob.exposure === "targeted";
      newJobAnnouncement = announcementJob as unknown as NewJobAnnouncement;
      if (newJobIsTargeted) {
        const recipientIds = [...new Set(recipients
          .map((recipient) => recipient.applicant_id)
          .filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0))];
        if (recipientIds.length > 0) {
          const { data: exposureRows, error: exposureError } = await supabase
            .from("job_exposure_targets")
            .select("applicant_id, mode")
            .eq("job_id", purposeJobId)
            .in("applicant_id", recipientIds);
          if (exposureError) {
            console.error("[bulk-send] new-job exposure lookup failed", exposureError);
            return NextResponse.json(
              { error: "공고 노출 대상을 확인하지 못했습니다." },
              { status: 503 },
            );
          }
          for (const row of exposureRows ?? []) {
            if (row.mode === "include" || row.mode === "exclude") {
              newJobExposureOverrides.set(row.applicant_id as number, row.mode);
            }
          }
        }
      }
    }

    // 수신자별 치환 — #{이름}, #{맞춤링크}(무로그인 pull 페이지 /p/[token]).
    // 기존엔 치환 없이 원문 그대로 발송돼 '#{이름}님' 문자가 나갔다.
    // 지원자 정보는 치환 여부와 무관하게 항상 로드 — 수신거부(sms_opt_out_at) 가드용.
    const needsFill = text.includes("#{이름}") || text.includes("#{맞춤링크}");
    const infoById = new Map<number, MessageApplicant>();
    {
      const ids = recipients
        .map((r) => r.applicant_id)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (ids.length > 0) {
        const { data: rows, error: applicantError } = await supabase
          .from("applicants")
          .select("id, name, phone, access_token, sms_opt_out_at, marketing_consent, status, sido, sigungu, availability, own_vehicle, work_hours, available_slots, lat, lng, applied_at, created_at")
          .in("id", ids);
        if (applicantError) {
          console.error("[bulk-send] applicants lookup failed", applicantError);
          if (newJobIsTargeted) {
            return NextResponse.json(
              { error: "공고 노출 대상 지원자를 확인하지 못했습니다." },
              { status: 503 },
            );
          }
        }
        for (const row of rows ?? []) {
          infoById.set(row.id as number, {
            id: row.id as number,
            name: (row.name as string | null) ?? null,
            phone: (row.phone as string | null) ?? null,
            access_token: (row.access_token as string | null) ?? null,
            sms_opt_out_at: (row.sms_opt_out_at as string | null) ?? null,
            marketing_consent: (row.marketing_consent as boolean | null) ?? null,
            status: (row.status as string | null) ?? null,
            sido: (row.sido as string | null) ?? null,
            sigungu: (row.sigungu as string | null) ?? null,
            availability: (row.availability as string | null) ?? null,
            own_vehicle: (row.own_vehicle as string | null) ?? null,
            work_hours: (row.work_hours as string | null) ?? null,
            available_slots: (row.available_slots as string[] | null) ?? null,
            lat: (row.lat as number | null) ?? null,
            lng: (row.lng as number | null) ?? null,
            applied_at: (row.applied_at as string | null) ?? null,
            created_at: (row.created_at as string | null) ?? null,
            suntopDone: false,
          });
        }
      }
    }
    const newJobExposureRule = newJobIsTargeted && newJobAnnouncement
      ? normalizeRule(newJobAnnouncement.exposure_rule)
      : null;
    const newJobSuntopDoneApplicantIds = new Set<number>();
    if (newJobIsTargeted && newJobExposureRule?.suntopDone && infoById.size > 0) {
      try {
        const suntopRows = await fetchAllPostgrestRows(async (from, to) => {
          const result = await supabase
            .from("pool_events")
            .select("id, applicant_id")
            .eq("event_type", "suntop_done")
            .in("applicant_id", [...infoById.keys()])
            .order("id", { ascending: true })
            .range(from, to);
          return {
            data: result.data as Array<{ id: number; applicant_id: number }> | null,
            error: result.error,
          };
        }, "새 공고 안내 선탑 완료 이력");
        for (const row of suntopRows) newJobSuntopDoneApplicantIds.add(row.applicant_id);
      } catch (suntopError) {
        console.error("[bulk-send] new-job suntop lookup failed", suntopError);
        return NextResponse.json(
          { error: "공고 노출 조건을 확인하지 못했습니다." },
          { status: 503 },
        );
      }
    }
    const newJobExposedApplicantIds = new Set<number>();
    if (newJobIsTargeted && newJobAnnouncement) {
      for (const [applicantId, info] of infoById) {
        if (isExposed(
          { ...info, suntopDone: newJobSuntopDoneApplicantIds.has(applicantId) },
          newJobExposureRule,
          newJobExposureOverrides.get(applicantId),
          { job: newJobAnnouncement },
        )) {
          newJobExposedApplicantIds.add(applicantId);
        }
      }
    }
    let phoneIdentityIndex: PhoneMessageIdentityIndex;
    try {
      phoneIdentityIndex = await fetchPhoneMessageIdentityIndex(supabase);
    } catch (identityError) {
      console.error("[bulk-send] phone identity lookup failed", identityError);
      return NextResponse.json(
        { error: "전화번호별 문자 수신 상태를 확인하지 못했습니다." },
        { status: 503 },
      );
    }
    const requestedPhones = new Set(
      recipients.map((recipient) => normalizePhone(recipient.phone ?? "")).filter(Boolean),
    );
    const recipientIdentityApplicantIds = [...new Set([...requestedPhones].flatMap(
      (phone) => phoneIdentityIndex.byPhone.get(phone)?.applicantIds ?? [],
    ))];
    const newJobCandidateApplicantIds = new Set<number>();
    if (purpose === "new_job" && purposeJobId !== null) {
      try {
        for (let offset = 0; offset < recipientIdentityApplicantIds.length; offset += APPLICANT_ID_BATCH_SIZE) {
          const batch = recipientIdentityApplicantIds.slice(offset, offset + APPLICANT_ID_BATCH_SIZE);
          const candidateRows = await fetchAllPostgrestRows(async (from, to) => {
            const result = await supabase
              .from("job_candidates")
              .select("id, applicant_id")
              .eq("job_id", purposeJobId)
              .in("applicant_id", batch)
              .order("id", { ascending: true })
              .range(from, to);
            return {
              data: result.data as Array<{ id: number; applicant_id: number }> | null,
              error: result.error,
            };
          }, "현재 공고 후보");
          for (const row of candidateRows) newJobCandidateApplicantIds.add(row.applicant_id);
        }
      } catch (candidateError) {
        console.error("[bulk-send] new-job candidates lookup failed", candidateError);
        return NextResponse.json(
          { error: "현재 공고 후보를 확인하지 못했습니다." },
          { status: 503 },
        );
      }
    }
    // 현재 지원 건의 운영 안내는 목적 태그만 신뢰하지 않는다. 공고 후보 또는 해당 공고에
    // 관심을 남긴 지원자로 서버에서 확인된 수신자만 운영 문자로 인정한다.
    const verifiedCurrentJobApplicantIds = new Set<number>();
    let hasApprovedCurrentJobBody = false;
    if (
      purposeJobId !== null
      && (purpose === "waitlist" || purpose === "job_closed")
    ) {
      const [candidateResult, interestResult] = await Promise.all([
        supabase
          .from("job_candidates")
          .select("applicant_id")
          .eq("job_id", purposeJobId),
        supabase
          .from("pool_events")
          .select("applicant_id")
          .eq("event_type", "interest_click")
          .eq("job_id", purposeJobId),
      ]);
      if (candidateResult.error) {
        console.error("[bulk-send] current-job candidates lookup failed", candidateResult.error);
      } else {
        for (const row of candidateResult.data ?? []) {
          if (typeof row.applicant_id === "number") {
            verifiedCurrentJobApplicantIds.add(row.applicant_id);
          }
        }
      }
      if (interestResult.error) {
        console.error("[bulk-send] current-job interests lookup failed", interestResult.error);
      } else {
        for (const row of interestResult.data ?? []) {
          if (typeof row.applicant_id === "number") {
            verifiedCurrentJobApplicantIds.add(row.applicant_id);
          }
        }
      }
    }
    if (purpose === "waitlist" && text !== CURRENT_JOB_WAITLIST_SMS_BODY) {
      return NextResponse.json({ error: "승인된 대기 안내 문구만 사용할 수 있습니다." }, { status: 400 });
    }
    if (purpose === "job_closed") {
      if (purposeJobId === null) {
        return NextResponse.json({ error: "마감 안내 공고를 확인할 수 없습니다." }, { status: 400 });
      }
      const { data: currentJob, error: currentJobError } = await supabase
        .from("jobs")
        .select("title, client:clients ( client_type )")
        .eq("id", purposeJobId)
        .maybeSingle();
      if (currentJobError) {
        console.error("[bulk-send] current job lookup failed", currentJobError);
        return NextResponse.json({ error: "마감 안내 공고를 확인하지 못했습니다." }, { status: 503 });
      }
      if (currentJob) {
        const joined = currentJob as unknown as { title: string; client?: unknown };
        hasApprovedCurrentJobBody = text === currentJobClosedSmsBody(
          joined.title,
          isGeneralLineJob({ title: joined.title, client_type: joinedClientType(joined.client) }),
        );
      }
      if (!hasApprovedCurrentJobBody) {
        return NextResponse.json({ error: "승인된 현재 공고 마감 안내 문구만 사용할 수 있습니다." }, { status: 400 });
      }
    }
    // 인력풀 제외자는 캠페인 발송 대상이 아니다 — 방어선(선택 UI가 걸러도 백엔드에서 재차 차단).
    const EXCLUDED_POOL_STATUS = new Set(["부적합", "이탈"]);
    const NEW_JOB_EXCLUDED_STATUS = new Set(["부적합", "이탈", "확정인력"]);

    // 중복 발송 가드 — 최근 10분 내 캠페인(system-bulk) 발송된 지원자는 재발송 스킵.
    // LMS 도달 지연에 매니저가 "안 왔다"고 재클릭해 같은 사람에게 두 번 나가는 것을 막는다.
    const DEDUP_WINDOW_MIN = 10;
    const recentlySentPhones = new Set<string>();
    {
      const ids = recipientIdentityApplicantIds;
      if (ids.length > 0) {
        const since = new Date(Date.now() - DEDUP_WINDOW_MIN * 60 * 1000).toISOString();
        try {
          for (let offset = 0; offset < ids.length; offset += APPLICANT_ID_BATCH_SIZE) {
            const batch = ids.slice(offset, offset + APPLICANT_ID_BATCH_SIZE);
            const recent = await fetchAllPostgrestRows(async (from, to) => {
              const result = await supabase
                .from("messages")
                .select("id, applicant_id, created_at")
                .in("applicant_id", batch)
                .eq("direction", "outbound")
                .eq("sent_by", "system-bulk")
                .gt("created_at", since)
                .order("created_at", { ascending: false })
                .order("id", { ascending: false })
                .range(from, to);
              return {
                data: result.data as Array<{ id: number; applicant_id: number; created_at: string }> | null,
                error: result.error,
              };
            }, "최근 일괄 문자 발송 이력");
            for (const message of recent) {
              const phone = phoneIdentityIndex.phoneByApplicantId.get(message.applicant_id);
              if (phone) recentlySentPhones.add(phone);
            }
          }
        } catch (recentMessageError) {
          console.error("[bulk-send] recent message lookup failed", recentMessageError);
          return NextResponse.json(
            { error: "최근 문자 발송 이력을 확인하지 못했습니다." },
            { status: 503 },
          );
        }
      }
    }
    // 공고 안내 교차 가드(24시간) — 마감 안내(job_closed)와 새 공고 안내(new_job)가 같은 사람에게
    // 몇 분 간격으로 겹쳐 나가는 상황을 실무자의 조작 순서와 무관하게 서버에서 차단한다.
    // 두 안내 모두 맞춤링크(살아있는 페이지)를 담고 있어 한 통이면 최신 상태가 전부 전달된다.
    // (지원자 경험 원칙, 2026-07-14. 10분 가드는 동일 발송 재클릭용 — 이 가드는 목적 교차용.)
    const CROSS_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
    // 'campaign' = 목적 없이 나간 공고 안내 성격의 캠페인. 24시간 교차 가드에는 포함하되,
    // 'new_job'과는 구분한다 — 공고탭 '대기자에게 안내'의 7일 피로도 필터가 new_job만 보기 때문에
    // 재컨택 발송을 new_job으로 태깅하면 충원 안내 이력 보유자가 안내 목록에서 사라진다.
    const CROSS_NOTICE_PURPOSES = new Set(["job_closed", "new_job", "campaign"]);
    // 목적을 안 실은 발송도 가드를 태운다 — 목적은 클라이언트가 '프리셋 본문과 글자까지 같을 때만' 싣기 때문에,
    // 자유 본문으로 공고를 하나씩 알리면(다공고 동시 게시에서 실제 일어나는 동선) 가드가 조회조차 되지 않아
    // 한 사람이 공고 수만큼 문자를 받는다. 단 **맞춤 공고 링크가 들어간 본문**(공고 안내 성격)만 태깅한다 —
    // '근무 시작 안내'·'추가 정보 확인 요청'처럼 링크 없는 발송까지 24시간 묶으면 정당한 발송이 막힌다.
    const looksLikeJobNotice = text.includes("#{맞춤링크}");
    const effectivePurpose = purpose || (looksLikeJobNotice ? "campaign" : "");
    const batchFingerprint = bulkBatchRequestFingerprint({
      body: text,
      subject,
      purpose: effectivePurpose,
      jobId: purposeJobId,
    });
    let batchClaimData: unknown;
    try {
      const batchClaim = await supabase.rpc("claim_bulk_message_batch", {
        p_request_id: bulkRequestId,
        p_request_fingerprint: batchFingerprint,
        p_body: text,
        p_subject: subject,
        p_effective_purpose: effectivePurpose,
        p_job_id: purposeJobId,
      });
      if (batchClaim.error) {
        console.error("[bulk-send] batch outbox claim failed", batchClaim.error);
        return NextResponse.json(
          { error: "발송 요청을 안전하게 저장하지 못해 문자를 보내지 않았습니다." },
          { status: 503 },
        );
      }
      batchClaimData = batchClaim.data;
    } catch (batchClaimError) {
      console.error("[bulk-send] batch outbox claim exception", batchClaimError);
      return NextResponse.json(
        { error: "발송 요청을 안전하게 저장하지 못해 문자를 보내지 않았습니다." },
        { status: 503 },
      );
    }
    const batchClaimOutcome = (
      batchClaimData && typeof batchClaimData === "object"
        ? (batchClaimData as { outcome?: unknown; reason?: unknown }).outcome
        : null
    );
    if (batchClaimOutcome === "conflict") {
      return NextResponse.json(
        { error: "같은 발송 요청 키를 다른 내용에 사용할 수 없습니다." },
        { status: 409 },
      );
    }
    if (batchClaimOutcome !== "claimed" && batchClaimOutcome !== "existing") {
      console.error("[bulk-send] unexpected batch outbox claim outcome", batchClaimData);
      return NextResponse.json(
        { error: "발송 요청 상태를 확인하지 못해 문자를 보내지 않았습니다." },
        { status: 503 },
      );
    }
    // 새 공고 안내는 대상 산정 화면의 7일 피로도 규칙을 발송 시점에도 다시 적용한다.
    // 두 모달을 오래 열어둔 뒤 차례로 보내도 두 번째 요청이 첫 번째 발송 이력을 반드시 보게 한다.
    const NEW_JOB_FATIGUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const recentlyReceivedNewJobNoticePhones = new Set<string>();
    if (purpose === "new_job") {
      const ids = recipientIdentityApplicantIds;
      if (ids.length > 0) {
        const since = new Date(Date.now() - NEW_JOB_FATIGUE_WINDOW_MS).toISOString();
        try {
          for (let offset = 0; offset < ids.length; offset += APPLICANT_ID_BATCH_SIZE) {
            const batch = ids.slice(offset, offset + APPLICANT_ID_BATCH_SIZE);
            const recent = await fetchAllPostgrestRows(async (from, to) => {
              const result = await supabase
                .from("pool_events")
                .select("id, applicant_id, created_at")
                .in("applicant_id", batch)
                .eq("event_type", "ping_sent")
                .eq("meta->>purpose", "new_job")
                .gt("created_at", since)
                .order("created_at", { ascending: false })
                .order("id", { ascending: false })
                .range(from, to);
              return {
                data: result.data as Array<{ id: number; applicant_id: number; created_at: string }> | null,
                error: result.error,
              };
            }, "최근 새 공고 안내 이력");
            for (const event of recent) {
              const phone = phoneIdentityIndex.phoneByApplicantId.get(event.applicant_id);
              if (phone) recentlyReceivedNewJobNoticePhones.add(phone);
            }
          }
        } catch (fatigueError) {
          console.error("[bulk-send] new-job fatigue lookup failed", fatigueError);
          return NextResponse.json(
            { error: "최근 새 공고 안내 이력을 확인하지 못했습니다." },
            { status: 503 },
          );
        }
      }
    }
    const recentNoticedPhones = new Set<string>();
    if (CROSS_NOTICE_PURPOSES.has(effectivePurpose)) {
      const ids = recipientIdentityApplicantIds;
      if (ids.length > 0) {
        const since = new Date(Date.now() - CROSS_NOTICE_WINDOW_MS).toISOString();
        try {
          for (let offset = 0; offset < ids.length; offset += APPLICANT_ID_BATCH_SIZE) {
            const batch = ids.slice(offset, offset + APPLICANT_ID_BATCH_SIZE);
            const recent = await fetchAllPostgrestRows(async (from, to) => {
              const result = await supabase
                .from("pool_events")
                .select("id, applicant_id, meta, created_at")
                .in("applicant_id", batch)
                .eq("event_type", "ping_sent")
                .gt("created_at", since)
                .order("created_at", { ascending: false })
                .order("id", { ascending: false })
                .range(from, to);
              return {
                data: result.data as Array<{ id: number; applicant_id: number; meta: unknown; created_at: string }> | null,
                error: result.error,
              };
            }, "최근 공고 안내 이력");
            for (const event of recent) {
              const eventPurpose = (event.meta as { purpose?: string } | null)?.purpose;
              if (eventPurpose && CROSS_NOTICE_PURPOSES.has(eventPurpose)) {
                const phone = phoneIdentityIndex.phoneByApplicantId.get(event.applicant_id);
                if (phone) recentNoticedPhones.add(phone);
              }
            }
          }
        } catch (crossNoticeError) {
          console.error("[bulk-send] cross-notice lookup failed", crossNoticeError);
          return NextResponse.json(
            { error: "최근 공고 안내 이력을 확인하지 못했습니다." },
            { status: 503 },
          );
        }
      }
    }

    // 재채용 블랙리스트 하드 가드 — "절대 재채용 불가" 명단은 어떤 발송에서도 제외(전화번호 정규화 매칭).
    const blacklistedPhones = await fetchBlacklistedPhones();

    const baseUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      "https://ong-boarding-pi.vercel.app";
    const normalizedBase = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;

    // 같은 번호로 두 번 나가는 것을 막는다 — 위 중복 가드는 전부 applicant_id 키라
    // 한 사람이 지원자 행 2개로 들어와 있으면(전화번호 중복 데이터) 각각 발송된다.
    const sentPhones = new Set<string>();

    for (const r of recipients) {
      const phone = normalizePhone(r.phone || "");
      if (!/^\d{10,11}$/.test(phone)) {
        results.push({ phone, success: false, error: "잘못된 번호" });
        continue;
      }
      if (sentPhones.has(phone)) {
        results.push({ phone, success: false, error: "같은 번호 중복 방지(1통만 발송)" });
        continue;
      }
      // 블랙리스트 하드 가드 — 절대 재채용 불가 명단(수신거부와 동일 계층, 서버 강제).
      if (blacklistedPhones.has(phone)) {
        results.push({ phone, success: false, error: "블랙리스트(발송 제외)" });
        continue;
      }

      const applicantId = typeof r.applicant_id === "number"
        && Number.isSafeInteger(r.applicant_id)
        && r.applicant_id > 0
        ? r.applicant_id
        : null;
      if (applicantId === null) {
        results.push({ phone, success: false, error: "지원자 정보 확인 불가(발송 제외)" });
        continue;
      }
      const info = infoById.get(applicantId);
      const hasVerifiedCurrentJobContext =
        verifiedCurrentJobApplicantIds.has(applicantId);
      if ((purpose === "waitlist" || purpose === "job_closed") && !hasVerifiedCurrentJobContext) {
        results.push({ phone, success: false, error: "현재 공고 관계 확인 불가(발송 제외)" });
        continue;
      }
      const smsCategory = classifyBulkSmsCategory({
        purpose,
        body: text,
        hasVerifiedCurrentJobContext,
        hasApprovedCurrentJobBody,
      });

      const phoneIdentity = phoneIdentityIndex.byPhone.get(phone);
      if (!phoneIdentity) {
        results.push({ phone, success: false, error: "지원자 정보 확인 불가(발송 제외)" });
        continue;
      }
      if (phoneIdentity.hasActiveSmsOptOut) {
        results.push({ phone, success: false, error: "수신거부(발송 제외)" });
        continue;
      }
      if (
        purpose === "new_job"
        && phoneIdentity.applicantIds.some((applicantId) => newJobCandidateApplicantIds.has(applicantId))
      ) {
        results.push({ phone, success: false, error: "이미 현재 공고 후보(발송 제외)" });
        continue;
      }
      if (
        purpose === "new_job"
        && newJobIsTargeted
        && (
          typeof r.applicant_id !== "number"
          || !newJobExposedApplicantIds.has(r.applicant_id)
        )
      ) {
        results.push({ phone, success: false, error: "공고 노출 대상 아님(발송 제외)" });
        continue;
      }

      // 신규 일자리·캠페인은 applicant_id와 전화번호가 실제 지원자 행에 일치하고,
      // marketing_consent=true인 경우만 발송한다. ID 누락·조회 실패·행 누락도 동의 없음으로 차단한다.
      const policyBlock = smsRecipientBlockReason({
        category: smsCategory,
        recipientPhone: phone,
        applicant: info
          ? {
              phone: info.phone,
              marketingConsent: info.marketing_consent,
              smsOptOutAt: info.sms_opt_out_at,
            }
          : undefined,
      });
      if (policyBlock === "opt_out") {
        results.push({ phone, success: false, error: "수신거부(발송 제외)" });
        continue;
      }
      if (policyBlock === "recipient_unverified") {
        results.push({ phone, success: false, error: "지원자 정보 확인 불가(발송 제외)" });
        continue;
      }
      if (policyBlock === "consent_required") {
        results.push({
          phone,
          success: false,
          error: "신규 일자리 문자 미동의(발송 제외)",
        });
        continue;
      }
      if (policyBlock === "unknown_category") {
        results.push({ phone, success: false, error: "발송 목적 확인 불가(발송 제외)" });
        continue;
      }
      // 인력풀 제외(부적합/이탈) 하드 가드 — 풀에서 뺀 지원자에겐 캠페인이 나가지 않는다.
      const excludedStatus = phoneIdentity.applicantStatuses.find((status) => (
        purpose === "new_job"
          ? NEW_JOB_EXCLUDED_STATUS.has(status)
          : EXCLUDED_POOL_STATUS.has(status)
      ));
      if (excludedStatus) {
        results.push({ phone, success: false, error: `인력풀 제외(${excludedStatus})` });
        continue;
      }
      // 중복 발송 가드 — 최근 10분 내 캠페인 발송된 지원자는 스킵.
      if (recentlySentPhones.has(phone)) {
        results.push({ phone, success: false, error: "최근 발송됨(중복 방지)" });
        continue;
      }
      // 새 공고 안내 피로도 최종 가드 — 대상 목록을 연 시각이 아니라 실제 발송 시각 기준.
      if (
        purpose === "new_job"
        && recentlyReceivedNewJobNoticePhones.has(phone)
      ) {
        results.push({ phone, success: false, error: "최근 7일 내 새 공고 안내 수신(중복 방지)" });
        continue;
      }
      // 공고 안내 교차 가드 — 24시간 내 마감/새 공고 안내를 이미 받은 지원자는 스킵.
      if (recentNoticedPhones.has(phone)) {
        results.push({ phone, success: false, error: "24시간 내 공고 안내 수신(중복 방지)" });
        continue;
      }

      let personalText = text;
      if (needsFill) {
        personalText = personalText.replace(/#\{이름\}/g, info?.name?.trim() || "고객");
        if (personalText.includes("#{맞춤링크}")) {
          if (!info?.access_token) {
            // 링크를 만들 수 없는 수신자에게 깨진 문구를 보내지 않는다.
            results.push({ phone, success: false, error: "맞춤링크 생성 불가(토큰 없음)" });
            continue;
          }
          personalText = personalText.replace(/#\{맞춤링크\}/g, `${normalizedBase}/p/${info.access_token}`);
        }
      }

      sentPhones.add(phone);
      const recipientKey = bulkRecipientIdempotencyKey(bulkRequestId, phone);
      const recipientFingerprint = bulkMessageRequestFingerprint({
        applicantId,
        phone,
        body: personalText,
        subject,
        purpose: effectivePurpose,
        jobId: purposeJobId,
      });
      const delivery = await deliverBulkMessage({
        claim: async () => {
          const claim = await supabase.rpc("claim_bulk_message_recipient", {
            p_batch_id: bulkRequestId,
            p_applicant_id: applicantId,
            p_applicant_phone: phone,
            p_personal_body: personalText,
            p_recipient_fingerprint: recipientFingerprint,
          });
          if (claim.error) {
            console.error("[bulk-send] recipient outbox claim failed", claim.error);
            return { kind: "error" as const, error: "발송을 안전하게 선점하지 못했습니다." };
          }
          if (!claim.data || typeof claim.data !== "object") {
            console.error("[bulk-send] malformed recipient outbox claim", claim.data);
            return { kind: "error" as const, error: "발송 요청 상태를 확인하지 못했습니다." };
          }
          const payload = claim.data as {
            outcome?: unknown;
            recipient_key?: unknown;
            status?: unknown;
            provider_message_id?: unknown;
            reason?: unknown;
          };
          if (payload.outcome === "blocked") {
            return {
              kind: "blocked" as const,
              reason: bulkGuardReasonMessage(payload.reason),
            };
          }
          if (payload.outcome === "conflict") return { kind: "conflict" as const };
          if (
            typeof payload.recipient_key !== "string"
            || payload.recipient_key !== recipientKey
          ) {
            console.error("[bulk-send] recipient outbox key mismatch", payload);
            return { kind: "error" as const, error: "발송 요청 식별자를 확인하지 못했습니다." };
          }
          if (payload.outcome === "claimed") return { kind: "claimed" as const };
          if (payload.outcome === "existing") {
            if (
              typeof payload.status !== "string"
              || !BULK_OUTBOX_STATUSES.has(payload.status as BulkMessageOutboxStatus)
            ) {
              console.error("[bulk-send] invalid existing outbox status", payload);
              return { kind: "error" as const, error: "기존 발송 요청 상태를 확인하지 못했습니다." };
            }
            return {
              kind: "existing" as const,
              request: {
                status: payload.status as BulkMessageOutboxStatus,
                providerMessageId: typeof payload.provider_message_id === "string"
                  ? payload.provider_message_id
                  : null,
              },
            };
          }
          console.error("[bulk-send] unexpected recipient outbox claim", payload);
          return { kind: "error" as const, error: "발송 요청 상태를 확인하지 못했습니다." };
        },
        send: () => sendSms(
          phone,
          personalText,
          subject,
          {
            clientRequestId: recipientKey,
            timeoutMs: BULK_SMS_PROVIDER_TIMEOUT_MS,
          },
        ),
        markUnknown: async (error) => {
          const marked = await supabase.rpc("record_bulk_message_provider_result", {
            p_recipient_key: recipientKey,
            p_result: "unknown",
            p_provider_message_id: null,
            p_error: error,
          });
          if (
            marked.error
            || (marked.data !== "recorded" && marked.data !== "deduped")
          ) {
            console.error("[bulk-send] unknown provider result record failed", marked);
            throw new Error("발송 불명 상태를 기록하지 못했습니다.");
          }
        },
        markFailed: async (error) => {
          const marked = await supabase.rpc("record_bulk_message_provider_result", {
            p_recipient_key: recipientKey,
            p_result: "failed",
            p_provider_message_id: null,
            p_error: error,
          });
          if (marked.error) console.error("[bulk-send] provider failure record failed", marked.error);
          return !marked.error && (marked.data === "recorded" || marked.data === "deduped");
        },
        markSent: async (providerMessageId) => {
          const marked = await supabase.rpc("record_bulk_message_provider_result", {
            p_recipient_key: recipientKey,
            p_result: "sent",
            p_provider_message_id: providerMessageId,
            p_error: null,
          });
          if (marked.error) console.error("[bulk-send] provider success record failed", marked.error);
          return !marked.error && (marked.data === "recorded" || marked.data === "deduped");
        },
        record: async () => {
          const finalized = await supabase.rpc("finalize_bulk_message_send", {
            p_recipient_key: recipientKey,
          });
          if (finalized.error) console.error("[bulk-send] history finalize failed", finalized.error);
          return !finalized.error
            && (finalized.data === "recorded" || finalized.data === "deduped");
        },
      });
      results.push({
        applicant_id: applicantId,
        phone,
        success: delivery.success,
        ...(delivery.error ? { error: delivery.error } : {}),
        delivery: delivery.state === "recorded" || delivery.state === "sent_unrecorded"
          ? "sent"
          : delivery.state === "unknown"
            ? "unknown"
            : "not_sent",
        state: delivery.state,
        recorded: delivery.state === "recorded",
        deduplicated: delivery.deduplicated,
        recovery_pending: delivery.recoveryPending === true,
      });

      await new Promise((r) => setTimeout(r, 150));
    }

    const normalizedResults = results.map((result, index) => ({
      applicant_id: result.applicant_id
        ?? (typeof recipients[index]?.applicant_id === "number" ? recipients[index].applicant_id : null),
      phone: result.phone,
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
      delivery: result.delivery ?? (result.success ? "sent" : "not_sent"),
      state: result.state ?? (result.success ? "recorded" : "blocked"),
      recorded: result.recorded ?? result.success,
      deduplicated: result.deduplicated ?? false,
      recovery_pending: result.recovery_pending ?? false,
    }));
    const deliverySummary = {
      sent: 0,
      already_sent: 0,
      sent_recovery_pending: 0,
      unknown: 0,
      failed: 0,
      guarded: 0,
    };
    for (const result of normalizedResults) {
      if (result.state === "recorded") {
        if (result.deduplicated) deliverySummary.already_sent += 1;
        else deliverySummary.sent += 1;
      } else if (result.state === "sent_unrecorded") {
        deliverySummary.sent_recovery_pending += 1;
      } else if (result.state === "unknown") {
        deliverySummary.unknown += 1;
      } else if (result.state === "failed") {
        deliverySummary.failed += 1;
      } else {
        deliverySummary.guarded += 1;
      }
    }
    return NextResponse.json({
      success: true,
      ...deliverySummary,
      recovery_pending: normalizedResults.filter((result) => result.recovery_pending).length,
      results: normalizedResults,
    });
  } catch (err) {
    console.error("[bulk-send] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
