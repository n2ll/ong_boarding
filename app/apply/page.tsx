"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, BriefcaseBusiness, CheckCircle2, ChevronDown, FileText, Loader2, RefreshCw } from "lucide-react";
import Image from "next/image";
import { SOURCE_LABELS } from "@/lib/applicant-source";
import {
  applyJobIntent,
  shouldShowApplyForm,
  type ApplyJobLoadState,
} from "@/lib/apply-job-flow";
import {
  type ApplicantFormData,
  type ApplicantValidationIssue,
} from "@/lib/applicant-form";
import {
  applicationCompletionKind,
  applicationInitialMessageUiState,
  applicationSubmissionProgress,
  isApplicationSubmissionResult,
  prepareApplicationSubmission,
  validateApplicationSubmission,
  type ApplicationSubmissionAttempt,
  type ApplicationSubmissionResult,
} from "@/lib/application-submission";
import { isRequestTimeoutError, requestWithTimeout } from "@/lib/request-timeout";

const TIMESLOTS = [
  { label: "평일 오전", sub: "월~금 09:00 ~ 14:00", value: "평일(월~금) 오전 타임 (09:00 ~ 14:00)" },
  { label: "평일 오후", sub: "월~금 12:00 ~ 17:00", value: "평일(월~금) 오후 타임 (12:00 ~ 17:00)" },
  { label: "주말 오전", sub: "토~일 09:00 ~ 14:00", value: "주말(토~일) 오전 타임 (09:00 ~ 14:00)" },
  { label: "주말 오후", sub: "토~일 12:00 ~ 17:00", value: "주말(토~일) 오후 타임 (12:00 ~ 17:00)" },
];

const LICENSE_TYPES = ["1종 보통", "2종 보통", "1종 대형", "없음"];
const APPLICATION_REQUEST_TIMEOUT_MS = 15_000;

type FormState = ApplicantFormData;

const INITIAL: FormState = {
  name: "",
  birthDate: "",
  phone: "",
  location: "",
  ownVehicle: "",
  licenseType: "",
  vehicleType: "",
  branch1: "",
  branch2: "",
  workHours: [],
  experience: "",
  introduction: "",
  availableDate: "",
  selfOwnership: "",
  marketingConsent: false,
};

// SOURCE_LABELS에 정의된 소스만 허용하고, 알 수 없는 값은 'direct'로 처리한다.
function normalizeSource(raw: string | null): string {
  if (raw && Object.prototype.hasOwnProperty.call(SOURCE_LABELS, raw)) return raw;
  return "direct";
}

function digits(raw: string, max: number): string {
  return raw.replace(/\D/g, "").slice(0, max);
}

const labelCls = "block text-[16px] font-bold text-foreground mb-2";
const inputCls =
  "w-full px-4 py-3.5 border border-control-border rounded-2xl text-[16px] focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring focus:ring-2 focus-visible:ring-ring/40 bg-input-background";
const requiredMark = <span className="text-error ml-0.5">*</span>;

function fieldErrorId(field: keyof FormState): string {
  return `${field}-error`;
}

function FieldError({
  field,
  issue,
}: {
  field: keyof FormState;
  issue: ApplicantValidationIssue | null;
}) {
  if (issue?.field !== field) return null;
  return (
    <p id={fieldErrorId(field)} className="mt-2 flex items-start gap-1.5 text-[14px] font-bold leading-relaxed text-error-strong">
      <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{issue.message}</span>
    </p>
  );
}

interface JobContext {
  id: number;
  title: string;
  branch: string | null;
  client_name: string | null;
  recruiting: boolean;
  vehicle_required: boolean;
}

function ApplyForm() {
  const searchParams = useSearchParams();
  const source = normalizeSource(searchParams.get("source"));
  const prefillBranch = searchParams.get("branch");
  const jobParam = searchParams.get("job");
  const jobIntent = applyJobIntent(jobParam);
  const jobId = jobIntent.kind === "job" ? jobIntent.id : null;

  const [form, setForm] = useState<FormState>(INITIAL);
  const [branches, setBranches] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationIssue, setValidationIssue] = useState<ApplicantValidationIssue | null>(null);
  const [submissionResult, setSubmissionResult] = useState<ApplicationSubmissionResult | null>(null);
  const [job, setJob] = useState<JobContext | null>(null);
  const [jobLoadState, setJobLoadState] = useState<ApplyJobLoadState>(
    jobIntent.kind === "job" ? "loading" : jobIntent.kind === "invalid" ? "unavailable" : "idle",
  );
  const [jobLoadAttempt, setJobLoadAttempt] = useState(0);
  const [jobLoadTimedOut, setJobLoadTimedOut] = useState(false);
  const [generalOptIn, setGeneralOptIn] = useState(false);
  const [manualBranchEntry, setManualBranchEntry] = useState({ branch1: false, branch2: false });
  const submissionAttemptRef = useRef<ApplicationSubmissionAttempt | null>(null);
  const successTitleRef = useRef<HTMLHeadingElement>(null);

  // 공고 지원 링크(?job=ID)로 들어오면 공고 맥락을 불러와 헤더에 표기하고 지점을 미리 채운다.
  useEffect(() => {
    setJob(null);
    setGeneralOptIn(false);
    if (jobIntent.kind === "general") {
      setJobLoadState("idle");
      setJobLoadTimedOut(false);
      return;
    }
    if (jobIntent.kind === "invalid" || jobId == null) {
      setJobLoadState("unavailable");
      setJobLoadTimedOut(false);
      return;
    }
    let cancelled = false;
    setJobLoadState("loading");
    setJobLoadTimedOut(false);
    (async () => {
      try {
        const { res, json } = await requestWithTimeout(async (signal) => {
          const res = await fetch(`/api/apply/job/${jobId}`, { signal });
          const json = res.ok ? await res.json() : null;
          return { res, json };
        }, APPLICATION_REQUEST_TIMEOUT_MS);
        if (cancelled) return;
        if (!res.ok) {
          setJobLoadState(res.status === 400 || res.status === 404 ? "unavailable" : "error");
          return;
        }
        const j = json.job as JobContext;
        if (cancelled || !j || j.id !== jobId) {
          if (!cancelled) setJobLoadState("error");
          return;
        }
        setJob(j);
        setJobLoadState("loaded");
        if (j.branch) setForm((prev) => (prev.branch1 ? prev : { ...prev, branch1: j.branch as string }));
      } catch (loadError) {
        if (!cancelled) {
          setJobLoadTimedOut(isRequestTimeoutError(loadError));
          setJobLoadState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, jobIntent.kind, jobLoadAttempt]);

  useEffect(() => {
    (async () => {
      try {
        const json = await requestWithTimeout(async (signal) => {
          const res = await fetch("/api/branches", { signal });
          return res.ok ? await res.json() : null;
        }, APPLICATION_REQUEST_TIMEOUT_MS);
        if (!json) return;
        setBranches((json.branches ?? []) as string[]);
      } catch {
        /* 지점 목록 못 불러와도 직접 입력 가능 */
      }
    })();
  }, []);

  // 공고별 지원 링크(?branch=지점명)로 들어오면 희망 지점 1순위를 미리 채운다.
  useEffect(() => {
    if (prefillBranch) {
      setForm((prev) => (prev.branch1 ? prev : { ...prev, branch1: prefillBranch }));
    }
  }, [prefillBranch]);

  useEffect(() => {
    if (!submissionResult) return;
    window.scrollTo({ top: 0, behavior: "auto" });
    requestAnimationFrame(() => successTitleRef.current?.focus({ preventScroll: true }));
  }, [submissionResult]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setError(null);
    if (validationIssue?.field === key) setValidationIssue(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const setManualBranch = (key: "branch1" | "branch2", value: string) => {
    setManualBranchEntry((current) => ({ ...current, [key]: true }));
    set(key, value);
  };

  const toggleWorkHour = (value: string) => {
    setError(null);
    if (validationIssue?.field === "workHours") setValidationIssue(null);
    setForm((prev) => ({
      ...prev,
      workHours: prev.workHours.includes(value)
        ? prev.workHours.filter((v) => v !== value)
        : [...prev.workHours, value],
    }));
  };

  const handleSubmit = async () => {
    const issue = validateApplicationSubmission(form, vehicleRequired);
    if (issue) {
      setError(issue.message);
      setValidationIssue(issue);
      requestAnimationFrame(() => {
        const field = document.getElementById(`field-${issue.field}`);
        field?.scrollIntoView({ behavior: "auto", block: "center" });
        field?.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
      });
      return;
    }
    setError(null);
    setValidationIssue(null);
    setSubmitting(true);
    try {
      const prepared = prepareApplicationSubmission(
        submissionAttemptRef.current,
        { ...form, source, jobId: submissionJobId },
        () => crypto.randomUUID(),
      );
      submissionAttemptRef.current = prepared.attempt;
      const { res, json } = await requestWithTimeout(async (signal) => {
        const res = await fetch("/api/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prepared.payload),
          signal,
        });
        const json = await res.json().catch(() => ({}));
        return { res, json };
      }, APPLICATION_REQUEST_TIMEOUT_MS);
      if (!res.ok) {
        if (res.status === 429) {
          const retryAfter = Number(
            json.retryAfterSeconds ?? res.headers.get("Retry-After"),
          );
          const retryMinutes = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.max(1, Math.ceil(retryAfter / 60))
            : 10;
          setError(
            `짧은 시간에 제출 요청이 여러 번 확인되어 잠시 보호 중이에요. 약 ${retryMinutes}분 후 같은 내용으로 다시 시도해주세요. 이미 접수했다면 다시 누르지 말고 안내 문자를 확인해주세요.`,
          );
          return;
        }
        setError(json.error || "제출에 실패했어요. 잠시 후 다시 시도해주세요.");
        return;
      }
      if (!isApplicationSubmissionResult(json)) {
        setError("접수 결과를 확인하지 못했어요. 잠시 후 다시 시도해주세요.");
        return;
      }
      setSubmissionResult(json);
    } catch (submitError) {
      setError(isRequestTimeoutError(submitError)
        ? "응답이 늦어 접수 결과를 확인하지 못했어요. 같은 내용으로 다시 시도하면 중복 접수 없이 상태를 다시 확인합니다."
        : "인터넷 연결을 확인한 뒤 같은 내용으로 다시 시도해주세요. 제출 내용이 같으면 중복 접수되지 않아요.");
    } finally {
      setSubmitting(false);
    }
  };

  const verifiedJob = job?.id === jobId ? job : null;
  const submissionJobId = verifiedJob?.recruiting ? verifiedJob.id : null;
  const vehicleRequired = verifiedJob?.recruiting ? verifiedJob.vehicle_required !== false : true;
  const progress = applicationSubmissionProgress(form, vehicleRequired);
  const showApplyForm = shouldShowApplyForm({
    intent: jobIntent,
    loadState: jobLoadState,
    recruiting: verifiedJob?.recruiting ?? null,
    generalOptIn,
  });
  const hasUnavailableJobLink = jobIntent.kind === "invalid" || jobLoadState === "unavailable";
  const invalidField = validationIssue?.field ?? null;
  const fieldA11y = (field: keyof FormState) => ({
    "aria-invalid": invalidField === field ? true : undefined,
    "aria-describedby": invalidField === field ? fieldErrorId(field) : undefined,
  });
  const fieldInputClass = (field: keyof FormState, extra = "") =>
    `${inputCls} ${invalidField === field ? "border-error focus-visible:border-error focus-visible:ring-error/25" : ""} ${extra}`;

  if (submissionResult) {
    const completionKind = applicationCompletionKind(submissionResult.jobApplication);
    const initialMessageState = applicationInitialMessageUiState(
      submissionResult.initialMessageDelivery,
    );
    const hasJobIssue = completionKind === "general_job_unchanged"
      || completionKind === "general_job_unavailable"
      || completionKind === "general_job_failed";
    const title = completionKind === "job_linked"
      ? "공고 지원 의사가 접수됐어요"
      : completionKind === "general_job_unchanged"
        ? "기본 지원 정보만 업데이트됐어요"
        : completionKind === "general_job_unavailable"
          ? "지원서는 접수됐지만 공고에는 연결되지 않았어요"
          : completionKind === "general_job_failed"
            ? "지원서는 접수됐지만 공고 연결을 확인하지 못했어요"
            : "지원서가 접수됐어요";
    return (
      <div className="min-h-dvh flex items-center justify-center p-5 sm:p-8">
        <div className="bg-card border border-border-strong rounded-3xl p-6 sm:p-10 max-w-[480px] w-full text-center shadow-sm">
          <div className={`mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full ${hasJobIssue ? "bg-warning-soft" : "bg-success-soft"}`}>
            {hasJobIssue
              ? <AlertCircle size={36} aria-hidden="true" className="text-warning-strong" />
              : <CheckCircle2 size={36} aria-hidden="true" className="text-success-strong" />}
          </div>
          <h1 ref={successTitleRef} tabIndex={-1} className="text-[24px] font-extrabold text-foreground mb-2">{title}</h1>
          <p className="text-[16px] text-gray-700 leading-relaxed">
            {form.name}님, 작성하신 내용을 매니저가 확인합니다.<br />
            근무 확정이 아니며, 매니저의 별도 안내가 있어야 다음 절차가 진행됩니다.
          </p>
          {completionKind === "general_job_unchanged" && (
            <p className="mt-5 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[14px] font-bold leading-relaxed text-warning-strong">
              이 공고의 검토 목록에는 다시 추가되지 않았어요. 기본 지원 정보만 업데이트됐고, 이 공고의 이전 처리 결과는 그대로 유지됩니다.
            </p>
          )}
          {completionKind === "general_job_unavailable" && (
            <p className="mt-5 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[14px] font-bold leading-relaxed text-warning-strong">
              선택한 공고에는 연결되지 않았고, 작성한 내용은 다른 일자리 검토용 지원서로 접수됐어요.
            </p>
          )}
          {completionKind === "general_job_failed" && (
            <p className="mt-5 rounded-2xl border border-error/25 bg-error-soft px-4 py-3 text-[14px] font-bold leading-relaxed text-error-strong">
              선택한 공고와의 연결 여부는 매니저 확인이 필요해요. {initialMessageState === "sent"
                ? "방금 받은 안내 문자에 답장해 알려주세요."
                : initialMessageState === "uncertain"
                  ? "안내 문자 발송 여부를 확인하지 못했어요. 잠시 뒤 문자 수신 여부를 확인해주세요."
                : "기존에 받은 문자 대화가 있다면 답장하거나 잠시 후 다시 확인해주세요."}
            </p>
          )}
          <p className="mt-5 border-t border-border pt-4 text-[14px] font-medium leading-relaxed text-muted-foreground">
            {initialMessageState === "sent"
              ? "안내 문자를 발송했어요. 다음 절차는 문자에서도 확인할 수 있습니다."
              : initialMessageState === "uncertain"
                ? "안내 문자 발송 여부를 확인하지 못했어요. 중복 발송을 막기 위해 같은 문자를 자동으로 다시 보내지 않았습니다."
              : "별도의 안내 문자는 발송되지 않았어요. 현재 화면에서 접수 결과를 확인해주세요."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh px-4 py-6 sm:px-5 sm:py-10 landscape:py-3">
      <div className="max-w-[560px] mx-auto w-full">
        {/* Header */}
        <div className="mb-6 text-center landscape:mb-3">
          <div className="inline-flex items-center gap-2.5 mb-3">
            <Image src="/onggoing-logo.png" alt="옹고잉" width={72} height={56} priority className="landscape:h-10 landscape:w-auto" />
            <h1 className="text-[18px] font-extrabold text-foreground">배송원 지원</h1>
          </div>
          <p className="text-[16px] text-muted-foreground">
            {showApplyForm ? (
              <>아래 항목을 작성해주세요. <span className="text-error-strong">*</span> 표시는 필수입니다.</>
            ) : (
              <>문자로 받으신 공고 상태를 먼저 확인할게요.</>
            )}
          </p>
        </div>

        {jobIntent.kind === "job" && jobLoadState === "loading" && (
          <section role="status" aria-live="polite" className="mb-6 flex items-center gap-3 rounded-2xl border border-border-strong bg-card px-5 py-5 shadow-sm">
            <Loader2 size={22} aria-hidden="true" className="shrink-0 animate-spin text-warning-strong" />
            <div className="text-left">
              <h2 className="text-[16px] font-extrabold text-foreground">지원할 공고를 확인하고 있어요</h2>
              <p className="mt-1 text-[14px] leading-relaxed text-muted-foreground">확인되면 지원서를 바로 보여드릴게요.</p>
            </div>
          </section>
        )}

        {!generalOptIn && jobLoadState === "error" && (
          <section role="alert" className="mb-6 rounded-2xl border border-error/30 bg-card px-5 py-5 shadow-sm">
            <div className="flex items-start gap-3">
              <AlertCircle size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-error-strong" />
              <div>
                <h2 className="text-[17px] font-extrabold text-foreground">
                  {jobLoadTimedOut ? "공고 확인 시간이 길어지고 있어요" : "공고 정보를 불러오지 못했어요"}
                </h2>
                <p className="mt-1 text-[14px] leading-relaxed text-muted-foreground">
                  {jobLoadTimedOut
                    ? "공고 상태를 확인하지 못했어요. 잠시 후 다시 불러오거나 다른 일자리 지원서를 작성할 수 있어요."
                    : "인터넷 연결을 확인한 뒤 다시 시도해주세요."}
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setJobLoadAttempt((attempt) => attempt + 1)}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-foreground px-4 text-[16px] font-extrabold text-white transition-colors hover:bg-foreground/90 active:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <RefreshCw size={18} aria-hidden="true" /> 다시 불러오기
              </button>
              <button
                type="button"
                onClick={() => setGeneralOptIn(true)}
                className="min-h-12 rounded-2xl border border-control-border bg-card px-4 text-[16px] font-bold text-foreground transition-colors hover:bg-muted active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                다른 일자리 지원하기
              </button>
            </div>
          </section>
        )}

        {!generalOptIn && hasUnavailableJobLink && (
          <section role="alert" className="mb-6 rounded-2xl border border-error/30 bg-card px-5 py-5 shadow-sm">
            <div className="flex items-start gap-3">
              <AlertCircle size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-error-strong" />
              <div>
                <h2 className="text-[17px] font-extrabold text-foreground">이 공고 링크를 확인할 수 없어요</h2>
                <p className="mt-1 text-[14px] leading-relaxed text-muted-foreground">주소가 잘못됐거나 더 이상 공개되지 않는 공고일 수 있어요.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setGeneralOptIn(true)}
              className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand-yellow px-4 text-[16px] font-extrabold text-foreground shadow-brand transition-colors hover:bg-yellow-500 active:bg-yellow-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <FileText size={18} aria-hidden="true" /> 다른 일자리 지원서 작성하기
            </button>
            <p className="mt-3 text-center text-[13px] leading-relaxed text-muted-foreground">받으신 문자에 답장하시면 매니저가 링크를 확인해드려요.</p>
          </section>
        )}

        {verifiedJob && (
          <section className="mb-6 rounded-2xl border border-border-strong bg-card px-5 py-5 shadow-sm">
            <div className="flex items-start gap-3">
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${verifiedJob.recruiting ? "bg-brand-muted text-warning-strong" : "bg-muted text-muted-foreground"}`}>
                <BriefcaseBusiness size={21} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className={`text-[13px] font-extrabold ${verifiedJob.recruiting ? "text-warning-strong" : "text-error-strong"}`}>
                  {verifiedJob.recruiting ? "모집 중인 공고" : "모집이 마감된 공고"}
                </div>
                <h2 className="mt-1 text-[18px] font-extrabold leading-snug text-foreground">{verifiedJob.title}</h2>
                <p className="mt-1 text-[14px] text-muted-foreground">
                  {[verifiedJob.client_name, verifiedJob.branch].filter(Boolean).join(" · ") || "옹고잉 배송원"}
                </p>
              </div>
            </div>
            {verifiedJob.recruiting ? (
              <p className="mt-4 rounded-xl border border-success/20 bg-success-soft px-3 py-2.5 text-[14px] font-bold leading-relaxed text-success-strong">
                아래 지원서를 제출하면 이 공고에 지원 의사가 전달됩니다. 근무 확정은 아니며, 매니저가 확인합니다.
              </p>
            ) : generalOptIn ? (
              <p className="mt-4 flex items-start gap-2 rounded-xl border border-info/20 bg-info-soft px-3 py-2.5 text-[14px] font-bold leading-relaxed text-info-strong">
                <FileText size={17} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>지금부터 작성하는 내용은 다른 일자리용 일반 지원서로 접수됩니다.</span>
              </p>
            ) : (
              <div className="mt-4 rounded-xl border border-error/25 bg-error-soft px-3 py-3">
                <p className="text-[14px] font-bold leading-relaxed text-error-strong">이 공고에는 더 이상 지원할 수 없어요. 원하시면 다른 일자리용 지원서를 남길 수 있어요.</p>
                <button
                  type="button"
                  onClick={() => setGeneralOptIn(true)}
                  className="mt-3 min-h-12 w-full rounded-xl bg-foreground px-4 text-[15px] font-extrabold text-white transition-colors hover:bg-foreground/90 active:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  다른 일자리 지원서 작성하기
                </button>
              </div>
            )}
          </section>
        )}

        {generalOptIn && !verifiedJob && (
          <section className="mb-6 flex items-start gap-3 rounded-2xl border border-info/20 bg-info-soft px-5 py-4 text-info-strong">
            <FileText size={20} aria-hidden="true" className="mt-0.5 shrink-0" />
            <div>
              <h2 className="text-[16px] font-extrabold">다른 일자리용 지원서를 작성하고 있어요</h2>
              <p className="mt-1 text-[14px] font-medium leading-relaxed">작성하신 조건에 맞는 일자리를 매니저가 확인합니다.</p>
            </div>
          </section>
        )}

        {showApplyForm && <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
        <div className={`sticky top-0 z-20 -mx-2 mb-5 bg-background/95 px-2 py-2 backdrop-blur-sm ${error ? "" : "landscape:static landscape:z-auto landscape:mx-0 landscape:mb-3 landscape:bg-transparent landscape:px-0 landscape:py-0 landscape:backdrop-blur-none"}`}>
          <div className="bg-card border border-border-strong rounded-2xl px-4 py-3 shadow-sm landscape:px-3 landscape:py-2">
            <div className="flex items-center justify-between gap-4 text-[14px]">
              <span className="font-extrabold text-foreground">필수 항목 {progress.completed} / {progress.total}</span>
              <span className="font-bold text-muted-foreground">작성 {progress.percent}%</span>
            </div>
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="필수 항목 작성 진행률"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
            >
              <div className="h-full rounded-full bg-brand-yellow transition-[width] motion-reduce:transition-none" style={{ width: `${progress.percent}%` }} />
            </div>
            {error && (
              <div role="alert" aria-live="assertive" className="mt-3 flex items-start gap-2 border-t border-error/20 pt-3 text-[14px] font-bold text-error-strong">
                <AlertCircle size={18} className="mt-0.5 shrink-0" /> {error}
              </div>
            )}
          </div>
        </div>

        <div className="bg-card border border-border-strong rounded-2xl p-5 sm:p-8 landscape:p-5 shadow-sm flex flex-col gap-7">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-[14px] font-extrabold text-white">1</span>
            <div>
              <h2 className="text-[18px] font-extrabold text-foreground">기본 정보</h2>
              <p className="mt-0.5 text-[14px] text-muted-foreground">연락과 근무지 안내에 필요한 정보예요.</p>
            </div>
          </div>

          {/* 이름 */}
          <div id="field-name">
            <label htmlFor="name" className={labelCls}>이름{requiredMark}</label>
            <input id="name" name="name" autoComplete="name" aria-required="true" {...fieldA11y("name")} className={fieldInputClass("name")} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="홍길동" />
            <FieldError field="name" issue={validationIssue} />
          </div>

          {/* 생년월일 */}
          <div id="field-birthDate">
            <label htmlFor="birthDate" className={labelCls}>생년월일 (6자리){requiredMark}</label>
            <input id="birthDate" name="birthDate" aria-required="true" {...fieldA11y("birthDate")} className={fieldInputClass("birthDate")} inputMode="numeric" value={form.birthDate} onChange={(e) => set("birthDate", digits(e.target.value, 6))} placeholder="예: 600101" />
            <FieldError field="birthDate" issue={validationIssue} />
          </div>

          {/* 연락처 */}
          <div id="field-phone">
            <label htmlFor="phone" className={labelCls}>연락처{requiredMark}</label>
            <input id="phone" name="phone" type="tel" autoComplete="tel-national" aria-required="true" {...fieldA11y("phone")} className={fieldInputClass("phone")} inputMode="numeric" value={form.phone} onChange={(e) => set("phone", digits(e.target.value, 11))} placeholder="01012345678" />
            <FieldError field="phone" issue={validationIssue} />
          </div>

          {/* 거주지 */}
          <div id="field-location">
            <label htmlFor="location" className={labelCls}>거주지 주소{requiredMark}</label>
            <input id="location" name="location" autoComplete="street-address" aria-required="true" {...fieldA11y("location")} className={fieldInputClass("location")} value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="예: 서울시 강남구 역삼동" />
            <FieldError field="location" issue={validationIssue} />
          </div>

          <div className="flex items-start gap-3 border-t border-border pt-7">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-[14px] font-extrabold text-white">2</span>
            <div>
              <h2 className="text-[18px] font-extrabold text-foreground">운전·근무 조건</h2>
              <p className="mt-0.5 text-[14px] text-muted-foreground">
                {vehicleRequired
                  ? "가능한 조건만 선택하면 맞는 일자리를 안내해드려요."
                  : "이 공고는 본인 차량이나 운전면허 없이 지원할 수 있어요."}
              </p>
            </div>
          </div>

          {vehicleRequired ? (
            <>
              {/* 자차 보유 */}
              <div id="field-ownVehicle">
                <div id="ownVehicle-label" className={labelCls}>자차(본인 차량) 보유{requiredMark}</div>
                <div role="group" aria-labelledby="ownVehicle-label" aria-required="true" {...fieldA11y("ownVehicle")} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {["있음", "없음"].map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      aria-pressed={form.ownVehicle === opt}
                      {...fieldA11y("ownVehicle")}
                      onClick={() => set("ownVehicle", opt)}
                      className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background min-h-12 rounded-2xl border-2 py-3.5 text-[16px] font-bold transition-colors ${form.ownVehicle === opt ? "border-foreground bg-foreground text-white" : "border-control-border bg-card text-gray-700 hover:border-foreground/50"}`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
                <FieldError field="ownVehicle" issue={validationIssue} />
              </div>

              {/* 운전면허 */}
              <div id="field-licenseType">
                <label htmlFor="licenseType" className={labelCls}>운전면허 종류{requiredMark}</label>
                <select id="licenseType" name="licenseType" aria-required="true" {...fieldA11y("licenseType")} className={fieldInputClass("licenseType")} value={form.licenseType} onChange={(e) => set("licenseType", e.target.value)}>
                  <option value="">선택해주세요</option>
                  {LICENSE_TYPES.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
                <FieldError field="licenseType" issue={validationIssue} />
              </div>

              {/* 이동 수단 */}
              <div id="field-vehicleType">
                <label htmlFor="vehicleType" className={labelCls}>이동 수단{requiredMark}</label>
                <input id="vehicleType" name="vehicleType" aria-required="true" {...fieldA11y("vehicleType")} className={fieldInputClass("vehicleType")} value={form.vehicleType} onChange={(e) => set("vehicleType", e.target.value)} placeholder="예: 오토바이 / 승용차" />
                <FieldError field="vehicleType" issue={validationIssue} />
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-success/20 bg-success-soft px-4 py-3 text-[14px] font-bold leading-relaxed text-success-strong">
              차량·면허·본인 명의 조건은 이 공고의 필수 항목이 아니므로 입력하지 않아도 됩니다.
            </div>
          )}

          {/* 희망 지점 */}
          <div id="field-branch1">
            <label htmlFor="branch1" className={labelCls}>희망 지점 (1순위){requiredMark}</label>
            {branches.length > 0 && !manualBranchEntry.branch1 ? (
              <select id="branch1" name="branch1" aria-required="true" {...fieldA11y("branch1")} className={fieldInputClass("branch1")} value={form.branch1} onChange={(e) => set("branch1", e.target.value)}>
                <option value="">선택해주세요</option>
                {form.branch1 && !branches.includes(form.branch1) && (
                  <option value={form.branch1}>{form.branch1}</option>
                )}
                {branches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            ) : (
              <input id="branch1" name="branch1" aria-required="true" {...fieldA11y("branch1")} className={fieldInputClass("branch1")} value={form.branch1} onChange={(e) => setManualBranch("branch1", e.target.value)} placeholder="희망 지점을 입력해주세요" />
            )}
            <FieldError field="branch1" issue={validationIssue} />
          </div>

          {/* 희망 지점 2순위 */}
          <details className="group overflow-hidden rounded-2xl border border-border bg-muted/30">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[15px] font-bold text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <span>다른 희망 지점 추가 <span className="font-medium text-muted-foreground">(선택)</span></span>
              <ChevronDown size={18} aria-hidden="true" className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
            </summary>
            <div className="border-t border-border px-4 pb-4 pt-3">
              <label htmlFor="branch2" className={labelCls}>희망 지점 (2순위)</label>
              {branches.length > 0 && !manualBranchEntry.branch2 ? (
                <select id="branch2" name="branch2" className={inputCls} value={form.branch2} onChange={(e) => set("branch2", e.target.value)}>
                  <option value="">선택 안 함</option>
                  {form.branch2 && !branches.includes(form.branch2) && (
                    <option value={form.branch2}>{form.branch2}</option>
                  )}
                  {branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              ) : (
                <input id="branch2" name="branch2" className={inputCls} value={form.branch2} onChange={(e) => setManualBranch("branch2", e.target.value)} placeholder="두 번째 희망 지점을 입력해주세요" />
              )}
            </div>
          </details>

          {/* 희망 근무 시간대 */}
          <div id="field-workHours">
            <div id="workHours-label" className={labelCls}>희망 근무 시간대 (복수 선택){requiredMark}</div>
            <div role="group" aria-labelledby="workHours-label" aria-required="true" {...fieldA11y("workHours")} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {TIMESLOTS.map((slot) => {
                const checked = form.workHours.includes(slot.value);
                return (
                  <button
                    key={slot.value}
                    type="button"
                    aria-pressed={checked}
                    {...fieldA11y("workHours")}
                    onClick={() => toggleWorkHour(slot.value)}
                    className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex items-center justify-between px-4 py-3.5 rounded-2xl border-2 text-left transition-all ${checked ? "border-brand-yellow bg-yellow-50" : "border-control-border bg-card hover:border-foreground/50"}`}
                  >
                    <div>
                      <div className="text-[16px] font-bold text-foreground">{slot.label}</div>
                      <div className="text-[13px] text-muted-foreground">{slot.sub}</div>
                    </div>
                    <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center ${checked ? "border-brand-yellow bg-brand-yellow" : "border-control-border"}`}>
                      {checked && <CheckCircle2 size={16} className="text-foreground" />}
                    </div>
                  </button>
                );
              })}
            </div>
            <FieldError field="workHours" issue={validationIssue} />
          </div>

          {/* 근무 가능 시작일 */}
          <div id="field-availableDate">
            <label htmlFor="availableDate" className={labelCls}>근무 가능 시작일{requiredMark}</label>
            <input id="availableDate" name="availableDate" type="date" aria-required="true" {...fieldA11y("availableDate")} className={fieldInputClass("availableDate")} value={form.availableDate} onChange={(e) => set("availableDate", e.target.value)} />
            <FieldError field="availableDate" issue={validationIssue} />
          </div>

          {vehicleRequired && (
            <div id="field-selfOwnership">
              <div id="selfOwnership-label" className={labelCls}>배달앱·정산계좌 본인 명의 가능 여부{requiredMark}</div>
              <div role="group" aria-labelledby="selfOwnership-label" aria-required="true" {...fieldA11y("selfOwnership")} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {["문제 없음", "문제 있음"].map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    aria-pressed={form.selfOwnership === opt}
                    {...fieldA11y("selfOwnership")}
                    onClick={() => set("selfOwnership", opt)}
                    className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background min-h-12 rounded-2xl border-2 py-3.5 text-[16px] font-bold transition-colors ${form.selfOwnership === opt ? "border-foreground bg-foreground text-white" : "border-control-border bg-card text-gray-700 hover:border-foreground/50"}`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
              <FieldError field="selfOwnership" issue={validationIssue} />
            </div>
          )}
        </div>

        <details className="group mt-5 overflow-hidden rounded-2xl border border-border-strong bg-card shadow-sm">
          <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <div className="text-left">
              <h2 className="text-[16px] font-extrabold text-foreground">추가 정보 <span className="font-medium text-muted-foreground">(선택)</span></h2>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">경력이나 소개를 남기고 싶을 때만 작성해주세요.</p>
            </div>
            <ChevronDown size={20} aria-hidden="true" className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
          </summary>

          <div className="flex flex-col gap-6 border-t border-border px-5 pb-5 pt-5 sm:px-8 sm:pb-8">
            {/* 경력 */}
            <div>
              <label htmlFor="experience" className={labelCls}>배달·운전 경력 (선택)</label>
              <textarea id="experience" name="experience" className={`${inputCls} min-h-[90px] resize-y`} value={form.experience} onChange={(e) => set("experience", e.target.value)} placeholder="예: 쿠팡이츠 도보 배달 1년" />
            </div>

            {/* 자기소개 */}
            <div>
              <label htmlFor="introduction" className={labelCls}>간단한 자기소개 (선택)</label>
              <textarea id="introduction" name="introduction" className={`${inputCls} min-h-[90px] resize-y`} value={form.introduction} onChange={(e) => set("introduction", e.target.value)} placeholder="자유롭게 작성해주세요" />
            </div>

            {/* 마케팅 동의 */}
            <label htmlFor="marketingConsent" className="flex min-h-11 cursor-pointer items-start gap-2 rounded-xl py-1 transition-colors hover:bg-muted/50">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center">
                <input id="marketingConsent" name="marketingConsent" type="checkbox" checked={form.marketingConsent} onChange={(e) => set("marketingConsent", e.target.checked)} className="h-6 w-6 accent-brand-yellow" />
              </span>
              <span className="py-2 text-[14px] leading-relaxed text-gray-700">채용·근무 관련 안내 문자 수신에 동의합니다. (선택)</span>
            </label>
          </div>
        </details>

        <button
          type="submit"
          disabled={submitting}
          className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full mt-4 min-h-14 bg-brand-yellow hover:bg-yellow-500 disabled:cursor-wait disabled:opacity-60 text-foreground px-4 py-4 rounded-2xl text-[16px] font-extrabold transition-colors flex items-center justify-center gap-2 shadow-brand"
        >
          {submitting ? <Loader2 size={20} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : null}
          {submitting ? "제출 중…" : submissionJobId ? "이 공고에 지원하기" : "지원서 제출하기"}
        </button>
        </form>}
        <div className="h-10" />
      </div>
    </div>
  );
}

export default function ApplyPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <ApplyForm />
    </Suspense>
  );
}
