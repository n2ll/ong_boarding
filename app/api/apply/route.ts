import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { getAgentMode } from "@/lib/agent/kill-switch";
import { sendNotification, sendSms } from "@/lib/solapi";
import { geocodeAddress } from "@/lib/kakao-geocode";
import { ensureBaeminSystemJob } from "@/lib/agent/baemin-job";
import { getSystemMessage, fillTemplate } from "@/lib/agent/system-messages";
import { resolveAutomatedOutboundText } from "@/lib/agent/outbound-safety";
import {
  APPLICATION_BRANCH_UNASSIGNED,
  applicationActiveFixedBranchName,
  applicationBranchContext,
  applicationBranchName,
  applicationBranchReceiptLine,
  applicationSourceRequiresBranchChoice,
  applicationUsesLegacyBmartFlow,
  resolveApplicationBranchSubmission,
  type ApplicationBranchContext,
} from "@/lib/application-branch";
import {
  normalizeDeclaredAcquisitionSource,
  normalizePublicTrackingRef,
  parseAcquisitionClaimResult,
  type AcquisitionClaimResult,
} from "@/lib/acquisition-attribution";
import {
  applicationCandidateFinalizationPlan,
  applicationReplayAttributionPlan,
  parseAcquisitionAttributionResult,
} from "@/lib/acquisition-attribution-outcome";
import { normalizeApplicantRoadAddress } from "@/lib/applicant-form";
import {
  normalizeTallySelfOwnership,
  normalizeTallyVehicleOwnership,
} from "@/lib/tally-webhook";
import {
  applicationAvailableDatePolicyForRequest,
  applicationFilterPasses,
  applicationInitialMessagePlan,
  applicationJobOutcome,
  applicationMarketingConsentFields,
  applicationOptionalAnswer,
  applicationOperationalFieldsForSubmission,
  applicationStatusForSubmission,
  applicationSubmissionMappingDecision,
  applicationSubmissionPayloadDigest,
  applicationVehicleRequired,
  deliverApplicationMessage,
  shouldStartApplicationAutoEngagement,
  shouldSetApplicationCurrentJob,
  shouldUpdateApplicationApplicant,
  validateApplicationSubmissionId,
  validateApplicationSubmission,
  type CandidateLinkOutcome,
  type ExistingApplicationMessageRequest,
  type ApplicationSubmissionResult,
} from "@/lib/application-submission";
import { publicJobAvailability } from "@/lib/public-job";
import {
  APPLICATION_INTERNAL_HEADER,
  applicationRateLimitHash,
  isTrustedApplicationInternalRequest,
  trustedApplicationClientIp,
} from "@/lib/application-rate-limit";
import {
  applicationReplayCandidateOutcome,
  applicationServerReplayPlan,
} from "@/lib/application-server-replay";

const APPLICATION_REPLAY_APPLICANT_FIELDS = [
  "id", "name", "phone", "branch", "branch1", "branch2", "work_hours", "source", "status", "note", "birth_date", "own_vehicle", "license_type",
  "vehicle_type", "self_ownership", "filter_pass", "available_slots",
  "available_slots_updated_at", "application_submission_id",
  "application_request_fingerprint", "application_auto_engagement_required",
  "marketing_consent", "marketing_consent_at", "sms_opt_out_at",
].join(", ");

interface ApplicationReplayApplicant {
  id: number;
  name: string;
  phone: string;
  branch: string | null;
  branch1: string | null;
  branch2: string | null;
  work_hours: string | null;
  source: string | null;
  status: string | null;
  note: string | null;
  birth_date: string | null;
  own_vehicle: string | null;
  license_type: string | null;
  vehicle_type: string | null;
  self_ownership: string | null;
  filter_pass: string | null;
  available_slots: unknown;
  available_slots_updated_at: string | null;
  application_submission_id: string | null;
  application_request_fingerprint: string | null;
  application_auto_engagement_required: boolean;
  marketing_consent: boolean | null;
  marketing_consent_at: string | null;
  sms_opt_out_at: string | null;
}

// 희망 근무 시간대 축약 — "평일(월~금) 오전 타임..., 주말..." → "평일오전, 주말오후"
function shortWorkHours(wh: string | null | undefined): string {
  if (!wh || wh === "미확인") return "";
  const out = wh
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      const day = p.includes("주말") ? "주말" : p.includes("평일") ? "평일" : "";
      const time = p.includes("오전") ? "오전" : p.includes("오후") ? "오후" : "";
      return day + time;
    })
    .filter(Boolean);
  return Array.from(new Set(out)).join(", ");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      name,
      birthDate,
      phone,
      location,
      ownVehicle,
      licenseType,
      vehicleType,
      branch1,
      branch2,
      workHours,
      introduction,
      experience,
      source,
      availableDate,
      selfOwnership,
      marketingConsent,
      jobId,
      trackingRef: rawTrackingRef,
      submissionId: rawSubmissionId,
    } = body;

    const validatedSubmissionId = validateApplicationSubmissionId(rawSubmissionId);
    if (!validatedSubmissionId.ok) {
      return NextResponse.json(
        {
          error: validatedSubmissionId.reason === "required"
            ? "제출 요청 키가 필요합니다. 화면을 새로고침한 뒤 다시 시도해주세요."
            : "제출 요청 키가 올바르지 않습니다.",
        },
        { status: 400 },
      );
    }
    const submissionId = validatedSubmissionId.id;

    const supabase = createServiceClient();
    const declaredSource = normalizeDeclaredAcquisitionSource(source);
    const trackingRef = normalizePublicTrackingRef(rawTrackingRef);
    const declaredRealJobId = Number(jobId);
    const declaredJobRequested = Number.isInteger(declaredRealJobId) && declaredRealJobId > 0;
    const submittedForm = {
      name: typeof name === "string" ? name : "",
      birthDate: typeof birthDate === "string" ? birthDate : "",
      phone: typeof phone === "string" ? phone : "",
      location: typeof location === "string" ? location : "",
      ownVehicle: typeof ownVehicle === "string" ? ownVehicle : "",
      licenseType: typeof licenseType === "string" ? licenseType : "",
      vehicleType: typeof vehicleType === "string" ? vehicleType : "",
      branch1: typeof branch1 === "string" ? branch1 : "",
      branch2: typeof branch2 === "string" ? branch2 : "",
      workHours: Array.isArray(workHours) ? workHours : [],
      experience: typeof experience === "string" ? experience : "",
      introduction: typeof introduction === "string" ? introduction : "",
      availableDate: typeof availableDate === "string" ? availableDate : "",
      selfOwnership: typeof selfOwnership === "string" ? selfOwnership : "",
      marketingConsent: typeof marketingConsent === "boolean" ? marketingConsent : null,
    };
    const submissionFingerprint = await applicationSubmissionPayloadDigest({
      ...submittedForm,
      source: declaredSource.source,
      jobId: declaredJobRequested ? declaredRealJobId : null,
    });
    const normalizedLocation = normalizeApplicantRoadAddress(submittedForm.location);
    const trustedInternal = isTrustedApplicationInternalRequest({
      source: declaredSource.source,
      submissionId,
      requestFingerprint: submissionFingerprint,
      providedSignature: req.headers.get(APPLICATION_INTERNAL_HEADER),
      secret: process.env.TALLY_SIGNING_SECRET?.trim() || null,
    });
    const canonicalSubmittedForm = trustedInternal
      ? {
          ...submittedForm,
          ownVehicle: normalizeTallyVehicleOwnership(submittedForm.ownVehicle),
          vehicleType: normalizeTallyVehicleOwnership(submittedForm.ownVehicle) === "있음"
            ? submittedForm.vehicleType
            : "",
          selfOwnership: normalizeTallySelfOwnership(submittedForm.selfOwnership),
        }
      : submittedForm;

    const rateLimitSecret = process.env.APPLY_RATE_LIMIT_SECRET?.trim()
      || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!rateLimitSecret) {
      console.error("[apply] admission hash secret missing");
      return NextResponse.json(
        {
          error: "제출 보호 기능을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
          retryable: true,
          code: "APPLICATION_ADMISSION_UNAVAILABLE",
        },
        { status: 503 },
      );
    }

    const clientIp = trustedApplicationClientIp(
      req as NextRequest & { ip?: unknown },
      process.env.VERCEL === "1",
    ) ?? "unavailable";
    let attributionClaim: AcquisitionClaimResult;
    try {
      const response = await supabase.rpc(
        "claim_application_submission_with_attribution",
        {
          p_submission_id: submissionId,
          p_request_fingerprint: submissionFingerprint,
          p_phone_hash: applicationRateLimitHash("phone", submittedForm.phone, rateLimitSecret),
          p_ip_hash: applicationRateLimitHash("ip", clientIp, rateLimitSecret),
          p_trusted_internal: trustedInternal,
          p_tracking_ref: trackingRef,
          p_declared_source: declaredSource.isRecognized ? declaredSource.source : null,
          p_declared_job_id: declaredJobRequested ? declaredRealJobId : null,
        },
      );
      attributionClaim = parseAcquisitionClaimResult(response);
    } catch (claimError) {
      console.error("[apply] durable attribution claim failed", claimError);
      return NextResponse.json(
        {
          error: "제출 보호 기능을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
          retryable: true,
          code: "APPLICATION_ADMISSION_UNAVAILABLE",
        },
        { status: 503 },
      );
    }
    if (attributionClaim.kind === "error") {
      if (attributionClaim.reason === "conflict") {
        return NextResponse.json(
          {
            error: "같은 제출 요청 키를 다른 지원 내용에 사용할 수 없습니다.",
            code: "APPLICATION_SUBMISSION_CONFLICT",
          },
          { status: 409 },
        );
      }
      if (attributionClaim.reason === "context_mismatch") {
        return NextResponse.json(
          {
            error: "지원 링크의 공고 또는 유입 정보가 변경되었습니다. 링크를 다시 확인해주세요.",
            code: "APPLICATION_CONTEXT_CHANGED",
          },
          { status: 409 },
        );
      }
      if (attributionClaim.reason === "rate_limited") {
        return NextResponse.json(
          {
            error: "짧은 시간에 제출 요청이 여러 번 확인되어 잠시 보호 중입니다.",
            retryable: true,
            retryAfterSeconds: attributionClaim.retryAfterSeconds,
            code: "APPLICATION_RATE_LIMITED",
          },
          {
            status: 429,
            headers: { "Retry-After": String(attributionClaim.retryAfterSeconds) },
          },
        );
      }
      console.error("[apply] durable attribution claim malformed");
      return NextResponse.json(
        {
          error: "제출 보호 기능을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
          retryable: true,
          code: "APPLICATION_ADMISSION_UNAVAILABLE",
        },
        { status: 503 },
      );
    }

    const effectiveSource = attributionClaim.attribution.source;
    const realJobId = attributionClaim.attribution.jobId ?? 0;
    const jobRequested = attributionClaim.attribution.jobId !== null;
    let publicJobOpen: boolean | null = jobRequested ? null : false;
    let jobVehicleRequired: boolean | null = null;
    let vehicleRequired = true;
    let branchContext: ApplicationBranchContext = { mode: "none" };
    let resolvedBranch = {
      branch1: APPLICATION_BRANCH_UNASSIGNED,
      branch2: null as string | null,
    };

    // 현재 공고를 다시 심사하기 전에 submission key의 영구 매핑부터 해석한다.
    // 이미 저장된 같은 payload replay는 공고가 이후 변경·삭제되어도 최초 접수를 되돌리지 않는다.
    const outboxLookup = await supabase
      .from("application_message_send_requests")
      .select("request_fingerprint, applicant_id, applicant_phone, body, job_id, sent_by, status, provider_message_id, message_type, template_id, auto_engagement_required, created_at")
      .eq("idempotency_key", submissionId)
      .maybeSingle();
    if (outboxLookup.error) {
      console.error("[apply] submission outbox mapping lookup failed", outboxLookup.error);
      return NextResponse.json(
        { error: "기존 제출 기록을 안전하게 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", retryable: true },
        { status: 503 },
      );
    }
    const existingInitialMessageRequest = outboxLookup.data
      ? outboxLookup.data as ExistingApplicationMessageRequest
      : null;
    let submissionMappedAt = typeof outboxLookup.data?.created_at === "string"
      ? outboxLookup.data.created_at
      : null;
    let mappingDecision = applicationSubmissionMappingDecision({
      requestFingerprint: submissionFingerprint,
      outbox: existingInitialMessageRequest
        ? {
            applicantId: existingInitialMessageRequest.applicant_id,
            requestFingerprint: existingInitialMessageRequest.request_fingerprint,
          }
        : null,
      applicant: null,
    });
    if (mappingDecision.kind === "conflict") {
      return NextResponse.json(
        { error: "같은 제출 요청 키를 다른 지원 내용에 사용할 수 없습니다." },
        { status: 409 },
      );
    }

    let mappedAutoEngagementRequired = existingInitialMessageRequest
      ? existingInitialMessageRequest.auto_engagement_required === true
      : null;
    if (mappingDecision.kind === "new") {
      const submissionMappingLookup = await supabase
        .from("application_submission_mappings")
        .select("request_fingerprint, applicant_id, auto_engagement_required, created_at")
        .eq("submission_id", submissionId)
        .maybeSingle();
      if (submissionMappingLookup.error) {
        console.error("[apply] submission mapping lookup failed", submissionMappingLookup.error);
        return NextResponse.json(
          { error: "제출 요청을 안전하게 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", retryable: true },
          { status: 503 },
        );
      }
      mappingDecision = applicationSubmissionMappingDecision({
        requestFingerprint: submissionFingerprint,
        outbox: null,
        applicant: submissionMappingLookup.data
          ? {
              applicantId: Number(submissionMappingLookup.data.applicant_id),
              requestFingerprint: typeof submissionMappingLookup.data.request_fingerprint === "string"
                ? submissionMappingLookup.data.request_fingerprint
                : null,
            }
          : null,
      });
      if (mappingDecision.kind === "conflict") {
        return NextResponse.json(
          { error: "같은 제출 요청 키를 다른 지원 내용에 사용할 수 없습니다." },
          { status: 409 },
        );
      }
      if (mappingDecision.kind === "reuse") {
        mappedAutoEngagementRequired = submissionMappingLookup.data?.auto_engagement_required === true;
        submissionMappedAt = typeof submissionMappingLookup.data?.created_at === "string"
          ? submissionMappingLookup.data.created_at
          : null;
      }
    } else if (existingInitialMessageRequest) {
      // outbox는 candidate 연결보다 늦게 선점될 수 있다. trigger 원장 시각을 우선해야
      // 같은 submission이 만든 auto-filter candidate를 과거 candidate로 오인하지 않는다.
      const ledgerTimestampLookup = await supabase
        .from("application_submission_mappings")
        .select("request_fingerprint, applicant_id, created_at")
        .eq("submission_id", submissionId)
        .maybeSingle();
      if (ledgerTimestampLookup.error) {
        console.error("[apply] submission mapping timestamp lookup failed", ledgerTimestampLookup.error);
      } else if (
        ledgerTimestampLookup.data?.request_fingerprint === submissionFingerprint
        && Number(ledgerTimestampLookup.data.applicant_id) === mappingDecision.applicantId
        && typeof ledgerTimestampLookup.data.created_at === "string"
      ) {
        submissionMappedAt = ledgerTimestampLookup.data.created_at;
      }
    }

    const acceptedReplay = mappingDecision.kind === "reuse";
    const replayPreflightPlan = applicationServerReplayPlan({
      acceptedReplay,
      storedFilterPass: null,
      sameAttemptApplicant: false,
    });
    if (replayPreflightPlan.requiresJobPreflight) {
      // 새 제출만 현재 공고의 공개 상태와 차량·지점 조건을 검증한다.
      if (jobRequested) {
        const { data: requestedJob, error: requestedJobError } = await supabase
          .from("jobs")
          .select("id, title, status, closes_at, exposure, recruit_mode, vehicle_required, branch, branch_id, client_id")
          .eq("id", realJobId)
          .maybeSingle();
        if (requestedJobError) {
          console.error("[apply] requested job lookup failed", requestedJobError);
          return NextResponse.json(
            { error: "공고 정보를 다시 확인하지 못했습니다. 잠시 후 다시 제출해주세요.", retryable: true },
            { status: 503 },
          );
        } else if (requestedJob) {
          const availability = publicJobAvailability({
            title: typeof requestedJob.title === "string" ? requestedJob.title : null,
            status: typeof requestedJob.status === "string" ? requestedJob.status : null,
            exposure: typeof requestedJob.exposure === "string" ? requestedJob.exposure : null,
            recruitMode: typeof requestedJob.recruit_mode === "string" ? requestedJob.recruit_mode : null,
            closesAt: typeof requestedJob.closes_at === "string" ? requestedJob.closes_at : null,
          });
          if (availability === "hidden") {
            return NextResponse.json(
              { error: "공고를 찾을 수 없습니다.", code: "APPLICATION_CONTEXT_CHANGED" },
              { status: 404 },
            );
          }
          publicJobOpen = availability === "open";
          jobVehicleRequired = requestedJob.vehicle_required !== false;

          let fixedBranch: string | null = null;
          if (typeof requestedJob.branch_id === "number") {
            let fixedBranchQuery = supabase
              .from("branches")
              .select("name, active, client_id")
              .eq("id", requestedJob.branch_id)
              .eq("active", true);
            if (typeof requestedJob.client_id === "number") {
              fixedBranchQuery = fixedBranchQuery.eq("client_id", requestedJob.client_id);
            }
            const { data: canonicalBranch, error: canonicalBranchError } = await fixedBranchQuery
              .maybeSingle();
            fixedBranch = applicationActiveFixedBranchName({
              name: typeof canonicalBranch?.name === "string" ? canonicalBranch.name : null,
              active: canonicalBranch?.active === true,
              clientId: typeof canonicalBranch?.client_id === "number" ? canonicalBranch.client_id : null,
              jobClientId: typeof requestedJob.client_id === "number" ? requestedJob.client_id : null,
            });
            if (canonicalBranchError || !fixedBranch) {
              return NextResponse.json(
                {
                  error: "공고의 근무지 정보를 다시 확인하지 못했습니다. 잠시 후 다시 제출해주세요.",
                  retryable: true,
                },
                { status: 503 },
              );
            }
          } else {
            const legacyBranchName = applicationBranchName(
              typeof requestedJob.branch === "string" ? requestedJob.branch : null,
            );
            if (legacyBranchName) {
              if (typeof requestedJob.client_id !== "number") {
                return NextResponse.json(
                  {
                    error: "공고의 근무지 정보를 다시 확인하지 못했습니다. 잠시 후 다시 제출해주세요.",
                    retryable: true,
                  },
                  { status: 503 },
                );
              }
              const { data: canonicalBranch, error: canonicalBranchError } = await supabase
                .from("branches")
                .select("name, active, client_id")
                .eq("client_id", requestedJob.client_id)
                .eq("name", legacyBranchName)
                .eq("active", true)
                .maybeSingle();
              fixedBranch = applicationActiveFixedBranchName({
                name: typeof canonicalBranch?.name === "string" ? canonicalBranch.name : null,
                active: canonicalBranch?.active === true,
                clientId: typeof canonicalBranch?.client_id === "number" ? canonicalBranch.client_id : null,
                jobClientId: requestedJob.client_id,
              });
              if (canonicalBranchError || !fixedBranch) {
                return NextResponse.json(
                  {
                    error: "공고의 근무지 정보를 다시 확인하지 못했습니다. 잠시 후 다시 제출해주세요.",
                    retryable: true,
                  },
                  { status: 503 },
                );
              }
            }
          }

          let activeBranches: string[] = [];
          if (!fixedBranch && typeof requestedJob.client_id === "number") {
            const { data: branchRows, error: branchRowsError } = await supabase
              .from("branches")
              .select("name")
              .eq("client_id", requestedJob.client_id)
              .eq("active", true)
              .order("sort_order", { ascending: true });
            if (branchRowsError) {
              return NextResponse.json(
                {
                  error: "공고의 선택 가능한 근무지를 확인하지 못했습니다. 잠시 후 다시 제출해주세요.",
                  retryable: true,
                },
                { status: 503 },
              );
            }
            activeBranches = (branchRows ?? [])
              .map((branch) => applicationBranchName(
                typeof branch.name === "string" ? branch.name : null,
              ))
              .filter((branch): branch is string => branch !== null);
          }
          branchContext = applicationBranchContext({
            fixedBranch,
            allowChoice: !fixedBranch && activeBranches.length > 0,
            activeBranches,
          });
        } else {
          return NextResponse.json(
            {
              error: "선택한 공고를 찾을 수 없습니다. 공고 상태를 다시 확인해주세요.",
              code: "APPLICATION_CONTEXT_CHANGED",
            },
            { status: 409 },
          );
        }
      } else {
        const sourceRequiresBranchChoice = applicationSourceRequiresBranchChoice(
          effectiveSource,
        );
        if (sourceRequiresBranchChoice) {
          const { data: branchClients, error: branchClientsError } = await supabase
            .from("clients")
            .select("id")
            .eq("client_type", "baemin_bmart")
            .eq("active", true);
          if (branchClientsError) {
            return NextResponse.json(
              { error: "지원 가능한 지점 범위를 확인하지 못했습니다. 잠시 후 다시 제출해주세요.", retryable: true },
              { status: 503 },
            );
          }
          const clientIds = (branchClients ?? [])
            .map((client) => Number(client.id))
            .filter((clientId) => Number.isInteger(clientId) && clientId > 0);
          let activeBranches: string[] = [];
          if (clientIds.length > 0) {
            const { data: branchRows, error: branchRowsError } = await supabase
              .from("branches")
              .select("name")
              .in("client_id", clientIds)
              .eq("active", true)
              .order("sort_order", { ascending: true });
            if (branchRowsError) {
              return NextResponse.json(
                { error: "지원 가능한 지점 목록을 확인하지 못했습니다. 잠시 후 다시 제출해주세요.", retryable: true },
                { status: 503 },
              );
            }
            activeBranches = (branchRows ?? [])
              .map((branch) => applicationBranchName(
                typeof branch.name === "string" ? branch.name : null,
              ))
              .filter((branch): branch is string => branch !== null);
          }
          if (sourceRequiresBranchChoice && activeBranches.length === 0) {
            return NextResponse.json(
              {
                error: "현재 선택 가능한 지점이 없습니다. 받으신 문자에 답장해 문의해주세요.",
                code: "APPLICATION_CONTEXT_CHANGED",
              },
              { status: 409 },
            );
          }
          branchContext = applicationBranchContext({
            fixedBranch: null,
            allowChoice: true,
            activeBranches,
          });
        }
      }

      vehicleRequired = applicationVehicleRequired({ jobRequested, jobVehicleRequired });
      const branchChoiceRequired = branchContext.mode === "choice";
      const validationIssue = validateApplicationSubmission(
        canonicalSubmittedForm,
        vehicleRequired,
        branchChoiceRequired,
        !trustedInternal,
        applicationAvailableDatePolicyForRequest({ trustedInternal }),
        !trustedInternal,
      );
      if (validationIssue) {
        return NextResponse.json(
          {
            error: validationIssue.message,
            field: validationIssue.field,
            code: "APPLICATION_CONTEXT_CHANGED",
          },
          { status: 400 },
        );
      }
      const branchResolution = resolveApplicationBranchSubmission(branchContext, {
        branch1: canonicalSubmittedForm.branch1,
        branch2: canonicalSubmittedForm.branch2,
      });
      if (!branchResolution.ok) {
        return NextResponse.json(
          {
            error: branchResolution.message,
            field: branchResolution.field,
            code: "APPLICATION_CONTEXT_CHANGED",
          },
          { status: 400 },
        );
      }
      resolvedBranch = branchResolution;
    } else if (jobRequested) {
      // 후보 연결 복구는 아래 원자 RPC가 현재 공고 상태를 다시 잠가 판단한다.
      publicJobOpen = true;
    }

    let mappedApplicant: ApplicationReplayApplicant | null = null;
    if (mappingDecision.kind === "reuse") {
      const mappedLookup = await supabase
        .from("applicants")
        .select(APPLICATION_REPLAY_APPLICANT_FIELDS)
        .eq("id", mappingDecision.applicantId)
        .maybeSingle();
      if (mappedLookup.error) {
        console.error("[apply] submission mapping applicant lookup failed", mappedLookup.error);
        return NextResponse.json(
          { error: "기존 제출의 지원자 기록을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", retryable: true },
          { status: 503 },
        );
      }
      if (!mappedLookup.data) {
        console.error("[apply] submission mapping applicant missing");
        return NextResponse.json(
          { error: "기존 제출의 지원자 기록을 확인하지 못했습니다. 매니저에게 문의해주세요." },
          { status: 409 },
        );
      }
      mappedApplicant = mappedLookup.data as unknown as ApplicationReplayApplicant;
    }

    // ── durable mapping이 없을 때만 기존 applicant를 전화번호로 조회 ─────────
    // 두 가지 케이스를 한 흐름으로 처리:
    //  (a) 배민 임시 row(triage가 미리 만든 row, status='스크리닝 전') → 폼 데이터로 UPDATE
    //  (b) 동일 전화로 이미 active(스크리닝 전/중/완료, 확정인력, 대기자) 상태인 row가 있는데
    //      지원자가 폼을 또 작성한 케이스 → 새 row INSERT 안 하고 기존 row UPDATE.
    //      (이전엔 source='baemin' 임시 row일 때만 UPDATE라 같은 사람이 두 row로 갈라지는 버그)
    // 부적합/이탈 상태인 옛 row는 active가 아니라 재지원으로 보고 새 row INSERT 한다.
    let phoneApplicant: ApplicationReplayApplicant | null = null;
    if (!mappedApplicant) {
      const phoneLookup = await supabase
        .from("applicants")
        .select(APPLICATION_REPLAY_APPLICANT_FIELDS)
        .eq("phone", phone)
        .order("created_at", { ascending: false })
        .limit(1);
      if (phoneLookup.error) {
        console.error("[apply] applicant phone lookup failed", phoneLookup.error);
        return NextResponse.json(
          { error: "기존 지원 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", retryable: true },
          { status: 503 },
        );
      }
      phoneApplicant = (phoneLookup.data?.[0] as unknown as ApplicationReplayApplicant | undefined) ?? null;
    }

    const existingRow = mappedApplicant ?? phoneApplicant;
    const idempotentReplay = mappingDecision.kind === "reuse";
    let isDuplicate = !!existingRow;
    const updateMode = shouldUpdateApplicationApplicant({
      hasExistingApplicant: !!existingRow,
      idempotentReplay,
      existingSource: typeof existingRow?.source === "string" ? existingRow.source : null,
      existingStatus: typeof existingRow?.status === "string" ? existingRow.status : null,
    });
    if (branchContext.mode === "none" && updateMode && existingRow) {
      const preservedBranch1 = applicationBranchName(existingRow.branch1)
        ?? applicationBranchName(existingRow.branch);
      if (preservedBranch1) {
        resolvedBranch = {
          branch1: preservedBranch1,
          branch2: applicationBranchName(existingRow.branch2),
        };
      }
    }
    // triage가 먼저 만든 배민 임시 행의 첫 폼 완성만 자동 흐름을 시작한다.
    // direct를 포함한 나머지 active 행은 '스크리닝 전'이어도 재제출이므로 재발송하지 않는다.
    const freshAutoEngagementRequired = shouldStartApplicationAutoEngagement({
      updateMode,
      existingSource: typeof existingRow?.source === "string" ? existingRow.source : null,
      existingStatus: typeof existingRow?.status === "string" ? existingRow.status : null,
      existingFilterPass: typeof existingRow?.filter_pass === "string" ? existingRow.filter_pass : null,
      existingBirthDate: typeof existingRow?.birth_date === "string" ? existingRow.birth_date : null,
    });
    const autoEngagementRequired = idempotentReplay
      ? mappedAutoEngagementRequired
        ?? (existingRow?.application_auto_engagement_required === true)
      : freshAutoEngagementRequired;

    const sameAttemptApplicant = mappedApplicant?.application_submission_id === submissionId
      && mappedApplicant.application_request_fingerprint === submissionFingerprint;
    const replayPlan = applicationServerReplayPlan({
      acceptedReplay: idempotentReplay,
      storedFilterPass: typeof mappedApplicant?.filter_pass === "string"
        ? mappedApplicant.filter_pass
        : null,
      sameAttemptApplicant,
    });
    // 신규만 현재 답변으로 판정한다. 이미 수락된 replay는 저장 당시 판정을 그대로 사용한다.
    const filterPass = replayPlan.kind === "accepted_replay"
      ? replayPlan.filterPass === true
      : applicationFilterPasses({
          ownVehicle: canonicalSubmittedForm.ownVehicle,
          licenseType,
          selfOwnership: canonicalSubmittedForm.selfOwnership,
          vehicleRequired,
        });

    // source는 유입 채널이다. 화주사 근거가 있는 레거시 배민 비마트 흐름만 자동 스크리닝한다.
    const legacyBmartIntake = !jobRequested && applicationUsesLegacyBmartFlow({
      source: effectiveSource,
      branch: resolvedBranch.branch1,
    });
    const autoStatus = !filterPass ? "부적합" : (legacyBmartIntake ? "스크리닝 중" : "스크리닝 전");
    const operationalFields = applicationOperationalFieldsForSubmission({
      updateMode,
      isDuplicate,
      submittedSource: effectiveSource,
      nextFilterPass: filterPass ? "Y" : "N",
      existing: existingRow
        ? {
            status: typeof existingRow.status === "string" ? existingRow.status : null,
            source: typeof existingRow.source === "string" ? existingRow.source : null,
            filterPass: typeof existingRow.filter_pass === "string" ? existingRow.filter_pass : null,
            note: typeof existingRow.note === "string" ? existingRow.note : null,
            availableSlots: existingRow.available_slots ?? null,
            availableSlotsUpdatedAt: typeof existingRow.available_slots_updated_at === "string"
              ? existingRow.available_slots_updated_at
              : null,
          }
        : null,
    });

    // ── 주소 지오코딩 (실패해도 저장 진행) ─────────────────
    const geo = replayPlan.persistsApplicant && normalizedLocation
      ? await geocodeAddress(normalizedLocation)
      : null;

    // ── Supabase에 저장 (UPDATE or INSERT) ─────────────────
    const consentFields = applicationMarketingConsentFields({
      submittedConsent: canonicalSubmittedForm.marketingConsent,
      trustedInternal,
      existingConsent: existingRow?.marketing_consent,
      existingConsentAt: existingRow?.marketing_consent_at,
      existingSmsOptOutAt: existingRow?.sms_opt_out_at,
      now: new Date().toISOString(),
    });
    const rowPayload = {
      name,
      birth_date: birthDate,
      phone,
      location: normalizedLocation,
      own_vehicle: applicationOptionalAnswer({ submitted: canonicalSubmittedForm.ownVehicle, existing: existingRow?.own_vehicle, required: vehicleRequired }),
      license_type: applicationOptionalAnswer({ submitted: licenseType, existing: existingRow?.license_type, required: vehicleRequired }),
      vehicle_type: !vehicleRequired
        ? applicationOptionalAnswer({ submitted: canonicalSubmittedForm.vehicleType, existing: existingRow?.vehicle_type, required: false })
        : canonicalSubmittedForm.ownVehicle === "있음"
          ? applicationOptionalAnswer({ submitted: canonicalSubmittedForm.vehicleType, existing: existingRow?.vehicle_type, required: true })
          : "미확인",
      branch1: resolvedBranch.branch1,
      branch2: resolvedBranch.branch2,
      work_hours: Array.isArray(workHours) ? workHours.join(", ") : workHours,
      // 폼을 다시 제출하면 그게 **가장 최신 본인 답**이다 — 예전 대화에서 AI가 채운 자기 신고를 비운다.
      // 안 비우면 판정이 available_slots를 절대 우선해서(applicantAvailableSlots) 방금 고른 시간대가 무시된다.
      available_slots: operationalFields.availableSlots,
      available_slots_updated_at: operationalFields.availableSlotsUpdatedAt,
      introduction: introduction?.trim() || null,
      experience: experience || null,
      available_date: availableDate,
      self_ownership: applicationOptionalAnswer({ submitted: canonicalSubmittedForm.selfOwnership, existing: existingRow?.self_ownership, required: true }),
      source: operationalFields.source,
      branch: resolvedBranch.branch1,
      status: updateMode
        ? applicationStatusForSubmission(existingRow?.status ?? null, autoStatus)
        : autoStatus,
      filter_pass: operationalFields.filterPass,
      note: operationalFields.note,
      marketing_consent: consentFields.marketingConsent,
      marketing_consent_at: consentFields.marketingConsentAt,
      sms_opt_out_at: consentFields.smsOptOutAt,
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null,
      sido: geo?.sido ?? null,
      sigungu: geo?.sigungu ?? null,
      bname: geo?.bname ?? null,
      road_address: trustedInternal ? geo?.road_address ?? null : normalizedLocation,
      application_submission_id: submissionId,
      application_request_fingerprint: submissionFingerprint,
      application_auto_engagement_required: autoEngagementRequired,
    };

    let inserted: ApplicationReplayApplicant | null = replayPlan.kind === "accepted_replay"
      ? mappedApplicant
      : null;
    let error: { message?: string; code?: string } | null = null;
    if (replayPlan.persistsApplicant && updateMode) {
      const { data, error: upErr } = await supabase
        .from("applicants")
        .update(rowPayload)
        .eq("id", existingRow!.id)
        .select()
        .single();
      inserted = (data as unknown as ApplicationReplayApplicant | null) ?? null;
      error = upErr;
    } else if (replayPlan.persistsApplicant) {
      const { data, error: inErr } = await supabase
        .from("applicants")
        .insert(rowPayload)
        .select()
        .single();
      inserted = (data as unknown as ApplicationReplayApplicant | null) ?? null;
      error = inErr;
    }

    // 같은 UUID를 두 요청이 동시에 처음 처리하면 DB 원장/고유 제약 중 하나가 loser를 막는다.
    // winner의 매핑을 다시 읽어 같은 applicant로 수렴시키며, 다른 payload 충돌은 거부한다.
    if (replayPlan.persistsApplicant && error?.code === "23505") {
      const concurrentMappingLookup = await supabase
        .from("application_submission_mappings")
        .select("request_fingerprint, applicant_id")
        .eq("submission_id", submissionId)
        .maybeSingle();
      if (!concurrentMappingLookup.error && concurrentMappingLookup.data) {
        const concurrentDecision = applicationSubmissionMappingDecision({
          requestFingerprint: submissionFingerprint,
          outbox: null,
          applicant: {
            applicantId: Number(concurrentMappingLookup.data.applicant_id),
            requestFingerprint: typeof concurrentMappingLookup.data.request_fingerprint === "string"
              ? concurrentMappingLookup.data.request_fingerprint
              : null,
          },
        });
        if (concurrentDecision.kind === "conflict") {
          return NextResponse.json(
            { error: "같은 제출 요청 키를 다른 지원 내용에 사용할 수 없습니다." },
            { status: 409 },
          );
        }
        if (concurrentDecision.kind === "reuse") {
          const concurrentApplicantLookup = await supabase
            .from("applicants")
            .select("*")
            .eq("id", concurrentDecision.applicantId)
            .maybeSingle();
          if (concurrentApplicantLookup.error || !concurrentApplicantLookup.data) {
            console.error("[apply] concurrent submission applicant lookup failed", concurrentApplicantLookup.error);
            return NextResponse.json(
              { error: "기존 제출의 지원자 기록을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", retryable: true },
              { status: 503 },
            );
          }
          inserted = concurrentApplicantLookup.data as unknown as ApplicationReplayApplicant;
          error = null;
          isDuplicate = true;
        }
      } else if (concurrentMappingLookup.error) {
        console.error("[apply] concurrent submission mapping lookup failed", concurrentMappingLookup.error);
      }
    }

    if (error || !inserted) {
      console.error("[Supabase insert/update error]", error);
      return NextResponse.json(
        { error: "데이터 저장 중 오류가 발생했습니다." },
        { status: 500 }
      );
    }

    const jobContextId = jobRequested ? realJobId : null;
    const startAutoEngagement = autoEngagementRequired && replayPlan.repairsMissingSideEffects;
    const insertedBranchName = applicationBranchName(inserted.branch);
    const insertedLegacyBmartIntake = !jobRequested && applicationUsesLegacyBmartFlow({
      source: effectiveSource,
      branch: insertedBranchName,
    });
    const initialMessagePlan = applicationInitialMessagePlan({
      startAutoEngagement,
      existingRequest: existingInitialMessageRequest,
    });

    // ── 자동 발송 ──────
    // 화주사 근거가 있는 레거시 비마트 흐름은 전용 시작 멘트를, 그 외엔 기본 접수 안내를 보낸다.
    // 둘 다 prompt_examples 테이블의 'system_message' 카테고리에서 매니저가 편집 가능.
    // active 재제출은 새 발송을 선점하지 않는다. 같은 제출 key의 outbox가 있을 때만 기록 복구를 시도한다.
    let initialMessageDelivery: ApplicationSubmissionResult["initialMessageDelivery"] = "not_sent";
    if (initialMessagePlan !== "skip") try {
      const receivedAt = new Date().toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
      const branchReceiptLine = applicationBranchReceiptLine(inserted.branch);
      const defaultReceived = [
        "[옹고잉 배송원 지원 접수 안내]",
        "",
        `${inserted.name}님, 안녕하세요.`,
        "옹고잉 배송원 지원서가 정상 접수되었습니다.",
        "",
        ...(branchReceiptLine ? [branchReceiptLine] : []),
        `▶ 접수일시: ${receivedAt}`,
        "",
        "서류 검토 후 영업일 기준 1~2일 내",
        "문자 또는 유선으로 안내드릴 예정입니다.",
        "",
        "문의사항은 본 메시지에 회신 주시면",
        "빠르게 안내드리겠습니다.",
      ].join("\n");

      // 어떤 멘트를 보낼지 결정 — source별 분기
      let sendBody: string;
      let sentByLabel: string;
      let useTemplate: "danggeun" | "apply_received" = "apply_received";

      if (initialMessagePlan === "replay") {
        sendBody = existingInitialMessageRequest!.body;
        sentByLabel = existingInitialMessageRequest!.sent_by;
      } else if (insertedLegacyBmartIntake && await getAgentMode(supabase, undefined, true) === "auto") {
        // 배민 비마트 임시중단 기간엔 폼에서 이미 받은 명시적 문자 선택을 그대로 존중한다.
        // 편집 가능한 과거 baemin_start는 미동의자에게 재동의를 묻거나 미래 안내를 약속할 수 있어 쓰지 않는다.
        // 플래그가 꺼져 있으면(=재개) 배민도 평시대로 danggeun_start를 공유한다.
        const baeminSuspended =
          effectiveSource === "baemin" &&
          !!(await getSystemMessage(supabase, "baemin_suspended"))?.trim();
        if (baeminSuspended) {
          const effectiveMarketingConsent =
            inserted.marketing_consent === true && !inserted.sms_opt_out_at;
          sendBody = [
            `${inserted.name}님, 지원해 주셔서 감사합니다.`,
            "현재 배민 비마트 배송 업무는 배민 측 사정으로 잠시 중단되어 바로 진행하기 어렵습니다.",
            effectiveMarketingConsent
              ? "새 일자리 안내 문자 수신에 동의해주셔서, 비슷한 배송 업무 공고가 생기면 이 번호로 안내드릴게요."
              : "새 일자리 안내 문자는 보내지 않고, 이번 비마트 지원 상태와 관련 문의에만 답변드릴게요.",
            "근무 여부는 매니저 검토 후 별도로 안내되며, 지금 확정된 것은 아닙니다.",
          ].join("\n\n");
          sentByLabel = "baemin-suspended";
          useTemplate = "danggeun";
        } else {
          const startMsg = (await getSystemMessage(supabase, "danggeun_start"))?.trim();
          if (!startMsg) {
            const stored = (await getSystemMessage(supabase, "apply_received"))?.trim();
            const filledStored = stored
              ? fillTemplate(stored, {
                  이름: inserted.name,
                  지점: insertedBranchName ?? "",
                  접수일시: receivedAt,
                })
              : null;
            const resolvedReceipt = resolveAutomatedOutboundText(filledStored, defaultReceived);
            if (!resolvedReceipt) throw new Error("unsafe automated receipt message");
            sendBody = resolvedReceipt;
            sentByLabel = "system-auto";
          } else {
            // 시작 멘트 {{이름}}/{{지점}}/{{시간대}} 치환
            const filledStart = fillTemplate(startMsg, {
              이름: inserted.name,
              지점: insertedBranchName ?? "",
              시간대: shortWorkHours(inserted.work_hours),
            });
            const resolvedStart = resolveAutomatedOutboundText(filledStart, defaultReceived);
            if (!resolvedStart) throw new Error("unsafe automated start message");
            sendBody = resolvedStart;
            sentByLabel = "baemin-start";
            useTemplate = "danggeun";
          }
        }
      } else {
        const stored = (await getSystemMessage(supabase, "apply_received"))?.trim();
        const filledStored = stored
          ? fillTemplate(stored, {
              이름: inserted.name,
              지점: insertedBranchName ?? "",
              접수일시: receivedAt,
            })
          : null;
        const resolvedReceipt = resolveAutomatedOutboundText(filledStored, defaultReceived);
        if (!resolvedReceipt) throw new Error("unsafe automated receipt message");
        sendBody = resolvedReceipt;
        sentByLabel = "system-auto";
      }

      const requestFingerprint = submissionFingerprint;
      const deliveryRequest = initialMessagePlan === "replay"
        ? {
            requestFingerprint: existingInitialMessageRequest!.request_fingerprint,
            applicantId: existingInitialMessageRequest!.applicant_id,
            phone: existingInitialMessageRequest!.applicant_phone,
            body: existingInitialMessageRequest!.body,
            jobId: existingInitialMessageRequest!.job_id,
            sentBy: existingInitialMessageRequest!.sent_by,
          }
        : {
            requestFingerprint,
            applicantId: inserted.id,
            phone: inserted.phone,
            body: sendBody,
            jobId: jobContextId,
            sentBy: sentByLabel,
          };
      const delivery = await deliverApplicationMessage({
        request: deliveryRequest,
        claim: async () => {
          if (initialMessagePlan === "replay") {
            return {
              kind: "existing" as const,
              request: existingInitialMessageRequest!,
            };
          }
          const claim = await supabase
            .from("application_message_send_requests")
            .insert({
              idempotency_key: submissionId,
              request_fingerprint: requestFingerprint,
              applicant_id: inserted.id,
              applicant_phone: inserted.phone,
              body: sendBody,
              job_id: jobContextId,
              sent_by: sentByLabel,
              message_kind: useTemplate === "danggeun" ? "start" : "receipt",
              auto_engagement_required: autoEngagementRequired,
              status: "sending",
            })
            .select("idempotency_key")
            .single();
          if (!claim.error) return { kind: "claimed" as const };
          if ((claim.error as { code?: string }).code !== "23505") {
            console.error("[apply message outbox claim error]", claim.error);
            return { kind: "error" as const };
          }

          const existingRequest = await supabase
            .from("application_message_send_requests")
            .select("request_fingerprint, applicant_id, applicant_phone, body, job_id, sent_by, status, provider_message_id, message_type, template_id, auto_engagement_required")
            .eq("idempotency_key", submissionId)
            .maybeSingle();
          if (existingRequest.error || !existingRequest.data) {
            console.error("[apply message outbox replay lookup error]", existingRequest.error);
            // 충돌 행은 존재하지만 상태를 읽지 못했다. 불명확 상태로 고정해 재발송을 막는다.
            return {
              kind: "existing" as const,
              request: {
                request_fingerprint: requestFingerprint,
                applicant_id: inserted.id,
                applicant_phone: inserted.phone,
                body: sendBody,
                job_id: jobContextId,
                sent_by: sentByLabel,
                status: "unknown",
                provider_message_id: null,
                message_type: null,
                template_id: null,
                auto_engagement_required: autoEngagementRequired,
              } satisfies ExistingApplicationMessageRequest,
            };
          }
          return {
            kind: "existing" as const,
            request: existingRequest.data as ExistingApplicationMessageRequest,
          };
        },
        send: async () => {
          if (initialMessagePlan === "replay") {
            throw new Error("application message replay attempted an external send");
          }
          // 시작 멘트는 SMS 직발송, 일반 접수 안내는 알림톡(APPLY_RECEIVED) 우선.
          if (useTemplate === "danggeun") {
            const sent = await sendSms(inserted.phone, sendBody);
            if (!sent.success) console.error("[apply start send]", sent.error);
            return {
              ...sent,
              messageType: "sms",
              templateId: null,
            };
          }
          const sent = await sendNotification(
            inserted.phone,
            "APPLY_RECEIVED",
            {
              "#{이름}": inserted.name,
              "#{지점}": insertedBranchName ?? "",
              "#{접수일시}": receivedAt,
            },
            sendBody,
          );
          if (!sent.success) console.error("[apply notify error]", sent.error);
          return {
            ...sent,
            messageType: sent.via,
            templateId: sent.templateId ?? null,
          };
        },
        markUnknown: async (lastError) => {
          const update = await supabase
            .from("application_message_send_requests")
            .update({ status: "unknown", last_error: lastError, updated_at: new Date().toISOString() })
            .eq("idempotency_key", submissionId)
            .eq("status", "sending");
          if (update.error) console.error("[apply message outbox unknown error]", update.error);
        },
        markFailed: async (lastError) => {
          const update = await supabase
            .from("application_message_send_requests")
            .update({ status: "failed", last_error: lastError, updated_at: new Date().toISOString() })
            .eq("idempotency_key", submissionId)
            .eq("status", "sending");
          if (update.error) console.error("[apply message outbox failed error]", update.error);
        },
        markSent: async ({ providerMessageId, messageType, templateId }) => {
          const update = await supabase
            .from("application_message_send_requests")
            .update({
              status: "sent",
              provider_message_id: providerMessageId,
              message_type: messageType,
              template_id: templateId,
              sent_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              last_error: null,
            })
            .eq("idempotency_key", submissionId)
            .eq("status", "sending")
            .select("idempotency_key")
            .maybeSingle();
          if (update.error || !update.data) {
            console.error("[apply message outbox sent error]", update.error);
            return false;
          }
          return true;
        },
        record: async (message) => {
          const insertedMessage = await supabase
            .from("messages")
            .insert({
              applicant_id: message.applicantId,
              applicant_phone: message.phone,
              direction: "outbound",
              body: message.body,
              status: "sent",
              sent_by: message.sentBy,
              solapi_msg_id: message.providerMessageId,
              message_type: message.messageType,
              template_id: message.templateId,
              job_id: message.jobId,
              client_request_id: submissionId,
            })
            .select("id")
            .maybeSingle();

          let recorded = !insertedMessage.error && Boolean(insertedMessage.data);
          if (!recorded) {
            const existingMessage = await supabase
              .from("messages")
              .select("id")
              .eq("client_request_id", submissionId)
              .maybeSingle();
            recorded = !existingMessage.error && Boolean(existingMessage.data);
            if (!recorded) {
              console.error(
                "[apply message record error]",
                insertedMessage.error,
                existingMessage.error,
              );
              return false;
            }
          }

          const recordedUpdate = await supabase
            .from("application_message_send_requests")
            .update({
              status: "recorded",
              recorded_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              last_error: null,
            })
            .eq("idempotency_key", submissionId)
            .in("status", ["sent", "recorded"]);
          if (recordedUpdate.error) {
            console.error("[apply message outbox recorded error]", recordedUpdate.error);
          }
          return true;
        },
      });
      initialMessageDelivery = delivery.delivery;
      if (delivery.conflict) {
        console.error("[apply message outbox fingerprint conflict]", { submissionId });
      }
    } catch (notifyErr) {
      console.error("[apply notify exception]", notifyErr);
    }

    // 화주사 근거가 있는 레거시 배민 비마트 지원자만 자동 AI 응대 흐름에 올린다.
    // SMS 인입 → 폼 발송 → 폼 제출 시점에 비로소 job_candidates를 생성한다.
    // outbox 이전에 중단된 replay도 아래 upsert로 시스템 후보 존재를 복구한다.
    if (startAutoEngagement && insertedLegacyBmartIntake) {
      try {
        const sysJobId = await ensureBaeminSystemJob(supabase);
        // 희망시간대에 '주말'이 없으면 평일 슬롯 → 공휴일 업무 확인 자동 통과
        const isWeekendSlot = String(inserted.work_hours ?? "").includes("주말");
        // agent_stage는 항상 'screening' 시작 — UI에 단계가 정상적으로 보이도록.
        // AI 응답 차단은 router 안의 kill switch 가드가 담당.
        const { error: jcErr } = await supabase.from("job_candidates").upsert(
          [{
            job_id: sysJobId,
            applicant_id: inserted.id,
            agent_stage: "screening",
            agent_state: {
              screening: {
                프로모션_종료가능성_안내: true,
                정산주기_안내: true,
                업무시간_체계_이해: true,
                ...(isWeekendSlot ? {} : { 공휴일_업무여부_확인: true }),
              },
              meta: { screening_entered_at: new Date().toISOString() },
            },
          }],
          { onConflict: "job_id,applicant_id", ignoreDuplicates: true },
        );
        if (jcErr) {
          console.error("[apply] job_candidates ensure error", jcErr);
        }
      } catch (e) {
        console.error("[apply] system job ensure failed", e);
      }
    }

    let persistedAttributionOutcome: unknown = null;
    if (replayPlan.kind === "accepted_replay") {
      const persistedAttributionLookup = await supabase
        .from("application_submission_attribution_outcomes")
        .select("request_fingerprint, applicant_id, candidate_link_outcome")
        .eq("submission_id", submissionId)
        .maybeSingle();
      if (persistedAttributionLookup.error) {
        console.error("[apply] persisted attribution outcome lookup failed", persistedAttributionLookup.error);
        return NextResponse.json(
          {
            error: "기존 지원 경로 기록을 안전하게 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
            retryable: true,
            code: "APPLICATION_ATTRIBUTION_UNAVAILABLE",
          },
          { status: 503 },
        );
      }
      persistedAttributionOutcome = persistedAttributionLookup.data;
    }
    const attributionReplayPlan = applicationReplayAttributionPlan({
      acceptedReplay: replayPlan.kind === "accepted_replay",
      persisted: persistedAttributionOutcome,
      requestFingerprint: submissionFingerprint,
      applicantId: inserted.id,
      jobRequested,
    });
    if (attributionReplayPlan.kind === "invalid") {
      console.error("[apply] persisted attribution outcome mismatch", { submissionId });
      return NextResponse.json(
        {
          error: "기존 지원 경로 기록이 현재 제출과 일치하지 않습니다.",
          retryable: true,
          code: "APPLICATION_ATTRIBUTION_UNAVAILABLE",
        },
        { status: 503 },
      );
    }

    // ── 실제 공고 지원 링크(?job=ID)로 들어온 경우 → 해당 공고 후보로 연결 ──
    // 외부 채널 게시물의 "지원하기"가 이 흐름을 타며, 매니저는 공고별 후보 보드에서 바로 확인/스크리닝한다.
    // (당근/배민 시스템 흐름은 위에서 별도 처리되므로 여기선 실공고만 처리)
    let candidateLinkOutcome: CandidateLinkOutcome = attributionReplayPlan.kind === "reuse"
      ? attributionReplayPlan.candidateLinkOutcome
      : jobRequested && publicJobOpen === false
        ? "unavailable"
        : null;
    if (
      attributionReplayPlan.kind === "repair"
      && jobRequested
      && publicJobOpen === true
    ) {
      try {
        let candidateReplayLookupComplete = replayPlan.kind !== "accepted_replay";
        // 영구 매핑된 replay는 최초 후보 연결을 먼저 보존한다. 공고가 이후 닫혀도
        // 현재 상태를 이유로 이미 존재하는 연결을 '미지원'으로 바꾸지 않는다.
        if (replayPlan.kind === "accepted_replay") {
          const existingCandidate = await supabase
            .from("job_candidates")
            .select("agent_stage, closed_at, closed_reason, created_at")
            .eq("job_id", realJobId)
            .eq("applicant_id", inserted.id)
            .maybeSingle();
          if (existingCandidate.error) {
            console.error("[apply] replay candidate lookup failed", existingCandidate.error);
          } else {
            candidateReplayLookupComplete = true;
            candidateLinkOutcome = applicationReplayCandidateOutcome({
              found: Boolean(existingCandidate.data),
              agentStage: typeof existingCandidate.data?.agent_stage === "string"
                ? existingCandidate.data.agent_stage
                : null,
              closedAt: typeof existingCandidate.data?.closed_at === "string"
                ? existingCandidate.data.closed_at
                : null,
              closedReason: typeof existingCandidate.data?.closed_reason === "string"
                ? existingCandidate.data.closed_reason
                : null,
              candidateCreatedAt: typeof existingCandidate.data?.created_at === "string"
                ? existingCandidate.data.created_at
                : null,
              submissionMappedAt,
              sameAttemptApplicant,
            });
          }
        }

        // 매핑 직후 중단되어 후보 연결이 없을 때만 원자 RPC로 복구한다.
        // RPC가 현재 공고 공개 상태까지 잠가 확인하므로 닫힌 공고를 새로 연결하지 않는다.
        if (
          candidateLinkOutcome === null
          && candidateReplayLookupComplete
          && replayPlan.repairsMissingSideEffects
        ) {
          const now = new Date().toISOString();
          const { data: linkOutcome, error: candidateLinkError } = await supabase.rpc(
            "link_public_job_candidate",
            {
              p_job_id: realJobId,
              p_applicant_id: inserted.id,
              p_agent_stage: filterPass ? "screening" : "abort",
              p_agent_state: filterPass
                ? { meta: { screening_entered_at: now, entry: "web_apply" } }
                : { meta: { auto_filtered_at: now, entry: "web_apply" } },
              p_closed_at: filterPass ? null : now,
              p_closed_reason: filterPass ? null : "auto: 자동 필터 부적합",
            },
          );
          if (candidateLinkError) {
            console.error("[apply] real job candidate link failed", candidateLinkError);
          } else if (
            linkOutcome === "linked"
            || linkOutcome === "already_linked"
            || linkOutcome === "unchanged_closed"
            || linkOutcome === "unavailable"
          ) {
            candidateLinkOutcome = linkOutcome;
            if (linkOutcome === "unavailable") publicJobOpen = false;
          } else {
            console.error("[apply] unexpected public job link outcome", linkOutcome);
          }
        }
        if (shouldSetApplicationCurrentJob(filterPass, candidateLinkOutcome)) {
          // 진행 중인 다른 공고가 없을 때만 이 공고를 현재 공고로 지정한다.
          // replay의 existing active candidate도 최초 연결의 durable 증거다.
          await supabase
            .from("applicants")
            .update({ current_job_id: realJobId })
            .eq("id", inserted.id)
            .is("current_job_id", null);
        }
      } catch (linkErr) {
        console.error("[apply] real job link failed", linkErr);
      }
    }

    const candidateFinalizationPlan = attributionReplayPlan.kind === "reuse"
      ? {
          kind: "finalize" as const,
          outcome: attributionReplayPlan.finalCandidateOutcome,
        }
      : applicationCandidateFinalizationPlan(jobRequested, candidateLinkOutcome);
    if (candidateFinalizationPlan.kind === "retry") {
      return NextResponse.json(
        {
          error: "공고 지원 연결을 완료하지 못했습니다. 잠시 후 다시 시도해주세요.",
          retryable: true,
          code: "APPLICATION_JOB_LINK_UNAVAILABLE",
        },
        { status: 503 },
      );
    }

    let attributionFinalizationRecorded = false;
    let attributionFinalizationError: unknown = null;
    try {
      const attributionFinalization = await supabase.rpc(
        "finalize_application_submission_attribution",
        {
          p_submission_id: submissionId,
          p_request_fingerprint: submissionFingerprint,
          p_applicant_id: inserted.id,
          p_candidate_link_outcome: candidateFinalizationPlan.outcome,
        },
      );
      const attributionFinalizationRow = Array.isArray(attributionFinalization.data)
        ? attributionFinalization.data.length === 1
          ? attributionFinalization.data[0]
          : null
        : attributionFinalization.data;
      attributionFinalizationError = attributionFinalization.error;
      attributionFinalizationRecorded = !attributionFinalization.error
        && parseAcquisitionAttributionResult(
          attributionFinalizationRow,
          submissionFingerprint,
        ) !== "failed";
    } catch (finalizationError) {
      attributionFinalizationError = finalizationError;
    }
    if (!attributionFinalizationRecorded) {
      console.error("[apply] attribution finalization failed", attributionFinalizationError);
      return NextResponse.json(
        {
          error: "지원 경로 기록을 안전하게 완료하지 못했습니다. 잠시 후 다시 시도해주세요.",
          retryable: true,
          code: "APPLICATION_ATTRIBUTION_UNAVAILABLE",
        },
        { status: 503 },
      );
    }

    const result = {
      success: true,
      duplicate: isDuplicate,
      jobApplication: applicationJobOutcome({
        jobRequested,
        candidateLinkOutcome,
      }),
      initialMessageSent: initialMessageDelivery === "sent",
      initialMessageDelivery,
    } satisfies ApplicationSubmissionResult;
    return NextResponse.json(result);
  } catch (err) {
    console.error("[apply API error]", err);
    return NextResponse.json(
      { error: "서버 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
