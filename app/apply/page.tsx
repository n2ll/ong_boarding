"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, BriefcaseBusiness, CheckCircle2, ChevronDown, FileText, Loader2, MapPin, RefreshCw, Search, X } from "lucide-react";
import Image from "next/image";
import { SOURCE_LABELS } from "@/lib/applicant-source";
import {
  applyJobLoadErrorDescription,
  applyJobIntent,
  applySubmissionJobContext,
  isApplicationBranchContextReady,
  shouldShowApplyForm,
  type ApplyJobLoadState,
} from "@/lib/apply-job-flow";
import {
  APPLICANT_BIRTH_DATE_ERROR_MESSAGE,
  APPLICANT_ROAD_ADDRESS_ERROR_MESSAGE,
  applicantRoadAddressFromPostcode,
  isValidApplicantBirthDate,
  isValidApplicantRoadAddress,
  type ApplicantFormData,
  type ApplicantValidationIssue,
} from "@/lib/applicant-form";
import { embedApplicantPostcode } from "@/lib/applicant-postcode";
import { applicationSourceRequiresBranchChoice } from "@/lib/application-branch";
import {
  applicationFormDraftContentKey,
  applicationFormDraftStorageKey,
  hasApplicationFormDraftContent,
  readApplicationFormDraftSnapshot,
  removeApplicationFormDraftSnapshot,
  removeApplicationFormDraftSnapshotIfContentKey,
  writeApplicationFormDraftSnapshot,
  type ApplicationFormDraftScope,
} from "@/lib/application-form-draft-storage";
import {
  applicationCompletionKind,
  applicationInitialMessageUiState,
  applicationSubmissionProgress,
  isApplicationSubmissionResult,
  prepareApplicationSubmission,
  resolveApplicationSubmissionContext,
  shouldAbandonApplicationSubmissionAttempt,
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
const KAKAO_POSTCODE_SCRIPT_ID = "kakao-postcode-script";
const KAKAO_POSTCODE_SCRIPT_URL = "https://t1.kakaocdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";

interface KakaoPostcodeOptions {
  oncomplete: (data: unknown) => void;
  onclose?: () => void;
  onresize?: (size: { height?: number }) => void;
  width?: string;
  height?: string;
  maxSuggestItems?: number;
}

interface KakaoPostcodeInstance {
  embed: (element: HTMLElement) => void;
}

declare global {
  interface Window {
    kakao?: {
      Postcode?: new (options: KakaoPostcodeOptions) => KakaoPostcodeInstance;
    };
  }
}

let kakaoPostcodeScriptPromise: Promise<void> | null = null;

function loadKakaoPostcodeScript(): Promise<void> {
  if (window.kakao?.Postcode) return Promise.resolve();
  if (kakaoPostcodeScriptPromise) return kakaoPostcodeScriptPromise;

  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(KAKAO_POSTCODE_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    const timeout = window.setTimeout(() => reject(new Error("postcode script timeout")), 10_000);
    const finish = () => {
      window.clearTimeout(timeout);
      if (window.kakao?.Postcode) resolve();
      else reject(new Error("postcode constructor missing"));
    };
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error("postcode script failed"));
    }, { once: true });
    if (!existing) {
      script.id = KAKAO_POSTCODE_SCRIPT_ID;
      script.src = KAKAO_POSTCODE_SCRIPT_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  });
  kakaoPostcodeScriptPromise = promise.catch((error) => {
    kakaoPostcodeScriptPromise = null;
    document.getElementById(KAKAO_POSTCODE_SCRIPT_ID)?.remove();
    throw error;
  });
  return kakaoPostcodeScriptPromise;
}

type FormState = ApplicantFormData;
type ApplyFormIssue = ApplicantValidationIssue | { field: "branch2"; message: string };

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

const APPLICATION_ERROR_FIELDS = new Set<ApplyFormIssue["field"]>([
  "name",
  "birthDate",
  "phone",
  "location",
  "ownVehicle",
  "licenseType",
  "vehicleType",
  "branch1",
  "branch2",
  "workHours",
  "availableDate",
  "selfOwnership",
]);

// SOURCE_LABELS에 정의된 소스만 허용하고, 알 수 없는 값은 'direct'로 처리한다.
function normalizeSource(raw: string | null): string {
  if (raw && Object.prototype.hasOwnProperty.call(SOURCE_LABELS, raw)) return raw;
  return "direct";
}

function digits(raw: string, max: number): string {
  return raw.replace(/\D/g, "").slice(0, max);
}

function getDraftStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function initialForm(branch: string | null): FormState {
  return { ...INITIAL, branch1: branch ?? "" };
}

const labelCls = "block text-[16px] font-bold text-foreground mb-2";
const inputCls =
  "w-full px-4 py-3.5 border border-control-border rounded-2xl text-[16px] focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring focus:ring-2 focus-visible:ring-ring/40 bg-input-background";
const requiredMark = (
  <>
    <span aria-hidden="true" className="text-error ml-0.5">*</span>
    <span className="sr-only"> (필수)</span>
  </>
);

function fieldErrorId(field: keyof FormState): string {
  return `${field}-error`;
}

function FieldError({
  field,
  issue,
}: {
  field: keyof FormState;
  issue: ApplyFormIssue | null;
}) {
  if (issue?.field !== field) return null;
  return (
    <p role="alert" id={fieldErrorId(field)} className="mt-2 flex items-start gap-1.5 text-[15px] font-bold leading-relaxed text-error-strong">
      <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{issue.message}</span>
    </p>
  );
}

interface JobContext {
  id: number;
  title: string;
  branch: string | null;
  branch_mode: "none" | "fixed" | "choice";
  branches: string[];
  client_name: string | null;
  recruiting: boolean;
  vehicle_required: boolean;
}

interface ApplyFormProps {
  source: string;
  prefillBranch: string | null;
  jobParam: string | null;
  draftScope: ApplicationFormDraftScope;
}

function ApplyForm({ source, prefillBranch, jobParam, draftScope }: ApplyFormProps) {
  const jobIntent = applyJobIntent(jobParam);
  const jobId = jobIntent.kind === "job" ? jobIntent.id : null;

  const [form, setForm] = useState<FormState>(INITIAL);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchListLoadState, setBranchListLoadState] = useState<ApplyJobLoadState>(
    jobIntent.kind === "general"
      && applicationSourceRequiresBranchChoice(source)
      ? "loading"
      : "idle",
  );
  const [branchListLoadAttempt, setBranchListLoadAttempt] = useState(0);
  const [addressLookupState, setAddressLookupState] = useState<"idle" | "loading" | "error">("idle");
  const [addressSearchOpen, setAddressSearchOpen] = useState(false);
  const [addressManualEntry, setAddressManualEntry] = useState(false);
  const [addressSearchHeight, setAddressSearchHeight] = useState(430);
  const [submitting, setSubmitting] = useState(false);
  const [submittingReplay, setSubmittingReplay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationIssue, setValidationIssue] = useState<ApplyFormIssue | null>(null);
  const [submissionResult, setSubmissionResult] = useState<ApplicationSubmissionResult | null>(null);
  const [job, setJob] = useState<JobContext | null>(null);
  const [jobLoadState, setJobLoadState] = useState<ApplyJobLoadState>(
    jobIntent.kind === "job" ? "loading" : jobIntent.kind === "invalid" ? "unavailable" : "idle",
  );
  const [jobLoadAttempt, setJobLoadAttempt] = useState(0);
  const [jobLoadTimedOut, setJobLoadTimedOut] = useState(false);
  const [generalOptIn, setGeneralOptIn] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [recoveryFormVisible, setRecoveryFormVisible] = useState(false);
  const [resetConfirming, setResetConfirming] = useState(false);
  const submissionAttemptRef = useRef<ApplicationSubmissionAttempt | null>(null);
  const persistedDraftKeyRef = useRef<string | null>(null);
  const completedDraftKeyRef = useRef<string | null>(null);
  const submitInFlightRef = useRef(false);
  const successTitleRef = useRef<HTMLHeadingElement>(null);
  const retryJobButtonRef = useRef<HTMLButtonElement>(null);
  const retryBranchesButtonRef = useRef<HTMLButtonElement>(null);
  const addressLookupButtonRef = useRef<HTMLButtonElement>(null);
  const locationInputRef = useRef<HTMLInputElement>(null);
  const addressSearchContainerRef = useRef<HTMLDivElement>(null);
  const secondBranchDetailsRef = useRef<HTMLDetailsElement>(null);
  const jobTitleRef = useRef<HTMLHeadingElement>(null);
  const unavailableJobTitleRef = useRef<HTMLHeadingElement>(null);
  const jobLoadingTitleRef = useRef<HTMLHeadingElement>(null);
  const applicationModeActionRef = useRef<HTMLButtonElement>(null);
  const generalApplicationTitleRef = useRef<HTMLHeadingElement>(null);
  const generalJobStatusRef = useRef<HTMLParagraphElement>(null);
  const resetDraftTriggerRef = useRef<HTMLButtonElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const pendingServerValidationRef = useRef<ApplyFormIssue | null>(null);

  const verifiedJob = job?.id === jobId ? job : null;
  const currentJobContext = applySubmissionJobContext({
    verifiedJobId: verifiedJob?.id ?? null,
    recruiting: verifiedJob?.recruiting === true,
    vehicleRequired: verifiedJob?.vehicle_required !== false,
    generalOptIn,
  });
  const currentSubmissionJobId = currentJobContext.jobId;
  const currentVehicleRequired = currentJobContext.vehicleRequired;
  const submissionContext = resolveApplicationSubmissionContext(
    submissionAttemptRef.current,
    { ...form, source, jobId: currentSubmissionJobId },
    currentVehicleRequired,
  );
  const pendingSubmissionReplay = submissionContext.reusesAttempt;
  const hasSubmissionAttempt = submissionAttemptRef.current !== null;
  const recoverySessionActive = recoveryFormVisible || hasSubmissionAttempt;
  const replayUiActive = pendingSubmissionReplay && (!submitting || submittingReplay);
  const submissionJobId = submissionContext.jobId;
  const vehicleRequired = submissionContext.vehicleRequired;
  const legacySourceBranchChoice = (jobIntent.kind === "general" || generalOptIn)
    && applicationSourceRequiresBranchChoice(source);
  const legacyBranchLookupRequired = legacySourceBranchChoice;
  const verifiedLegacyBranch = legacySourceBranchChoice && prefillBranch?.trim()
    && branches.includes(prefillBranch.trim())
    ? prefillBranch.trim()
    : null;
  const jobBranchContextActive = currentSubmissionJobId !== null && verifiedJob !== null;
  const branchContextReady = isApplicationBranchContextReady({
    intent: jobIntent,
    generalOptIn,
    jobLoadState,
    jobBranchContextActive,
    branchLookupRequired: legacyBranchLookupRequired,
    branchListLoadState,
  });
  const branchMode: JobContext["branch_mode"] = jobBranchContextActive
    ? verifiedJob.branch_mode
    : verifiedLegacyBranch
      ? "fixed"
      : legacySourceBranchChoice
        ? "choice"
        : "none";
  const branchOptions = jobBranchContextActive && verifiedJob.branch_mode === "choice"
    ? verifiedJob.branches
    : branches;
  const branchOptionsKey = branchOptions.join("\u0000");
  const fixedBranch = jobBranchContextActive && verifiedJob.branch_mode === "fixed"
    ? verifiedJob.branch
    : verifiedLegacyBranch;
  const branchChoiceRequired = branchMode === "choice";
  const branchContextLoading = legacyBranchLookupRequired && branchListLoadState === "loading";
  const branchChoicesLoading = legacySourceBranchChoice && branchListLoadState === "loading";
  const branchChoicesUnavailable = legacySourceBranchChoice
    && (branchListLoadState === "error"
      || (branchListLoadState === "loaded" && branchOptions.length === 0));
  const defaultBranch = fixedBranch || "";
  const currentApplyFormAvailable = shouldShowApplyForm({
    intent: jobIntent,
    loadState: jobLoadState,
    recruiting: verifiedJob?.recruiting ?? null,
    generalOptIn,
  });
  const applicationModeChoiceRequired = recoverySessionActive
    && !pendingSubmissionReplay
    && !currentApplyFormAvailable;
  const waitingForApplicationContext = (applicationModeChoiceRequired
    && jobLoadState === "loading") || branchContextLoading || branchChoicesUnavailable;

  useEffect(() => {
    void loadKakaoPostcodeScript().catch(() => {
      // 주소 찾기 버튼에서 재시도하며, 선로딩 실패만으로 폼 전체 오류를 띄우지 않는다.
    });
  }, []);

  // 공고 지원 링크(?job=ID)로 들어오면 공고 맥락을 불러와 헤더에 표기하고 지점을 미리 채운다.
  useEffect(() => {
    setJob(null);
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
        if (
          cancelled
          || !j
          || j.id !== jobId
          || !["none", "fixed", "choice"].includes(j.branch_mode)
          || !Array.isArray(j.branches)
          || (j.branch_mode === "fixed" && !j.branch?.trim())
          || (j.branch_mode === "choice" && j.branches.length === 0)
        ) {
          if (!cancelled) setJobLoadState("error");
          return;
        }
        setJob(j);
        setJobLoadState("loaded");
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
    setBranches([]);
    if (!legacyBranchLookupRequired) {
      setBranchListLoadState("idle");
      return;
    }
    let cancelled = false;
    setBranchListLoadState("loading");
    (async () => {
      try {
        const { res, json } = await requestWithTimeout(async (signal) => {
          const res = await fetch("/api/branches", { signal });
          const json = res.ok ? await res.json() : null;
          return { res, json };
        }, APPLICATION_REQUEST_TIMEOUT_MS);
        if (cancelled) return;
        if (!res.ok || !json || !Array.isArray(json.branches)) {
          setBranchListLoadState("error");
          return;
        }
        setBranches(json.branches.filter((branch: unknown): branch is string => (
          typeof branch === "string" && Boolean(branch.trim())
        )));
        setBranchListLoadState("loaded");
      } catch {
        if (!cancelled) setBranchListLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchListLoadAttempt, legacyBranchLookupRequired]);

  useEffect(() => {
    const snapshot = readApplicationFormDraftSnapshot(draftScope, getDraftStorage());
    if (snapshot) {
      setForm(snapshot.form);
      setGeneralOptIn(snapshot.generalOptIn);
      submissionAttemptRef.current = snapshot.submissionAttempt;
      setRecoveryFormVisible(snapshot.submissionAttempt !== null);
      persistedDraftKeyRef.current = applicationFormDraftContentKey(
        snapshot.form,
        snapshot.generalOptIn,
        snapshot.submissionAttempt,
      );
      setDraftRestored(hasApplicationFormDraftContent(
        snapshot.form,
        false,
        snapshot.submissionAttempt,
        initialForm(prefillBranch),
      ));
    }
    setDraftReady(true);
  }, [draftScope.branch, draftScope.job, draftScope.source, prefillBranch]);

  useEffect(() => {
    if (!draftReady || pendingSubmissionReplay || !branchContextReady) return;
    if (branchMode === "fixed" && fixedBranch) {
      setForm((current) => current.branch1 === fixedBranch && !current.branch2
        ? current
        : { ...current, branch1: fixedBranch, branch2: "" });
      return;
    }
    if (branchMode === "none") {
      setForm((current) => !current.branch1 && !current.branch2
        ? current
        : { ...current, branch1: "", branch2: "" });
      return;
    }
    const choicesReady = jobBranchContextActive || branchListLoadState === "loaded";
    if (!choicesReady) return;
    const validBranches = branchOptionsKey ? branchOptionsKey.split("\u0000") : [];
    setForm((current) => {
      const branch1 = validBranches.includes(current.branch1) ? current.branch1 : "";
      const branch2 = validBranches.includes(current.branch2) && current.branch2 !== branch1
        ? current.branch2
        : "";
      return branch1 === current.branch1 && branch2 === current.branch2
        ? current
        : { ...current, branch1, branch2 };
    });
  }, [
    branchListLoadState,
    branchContextReady,
    branchMode,
    branchOptionsKey,
    draftReady,
    fixedBranch,
    jobBranchContextActive,
    pendingSubmissionReplay,
  ]);

  useEffect(() => {
    if (!draftReady || pendingSubmissionReplay || form.ownVehicle === "있음" || !form.vehicleType) {
      return;
    }
    setForm((current) => current.ownVehicle !== "있음" && current.vehicleType
      ? { ...current, vehicleType: "" }
      : current);
  }, [draftReady, form.ownVehicle, form.vehicleType, pendingSubmissionReplay]);

  useEffect(() => {
    if (!draftReady) return;
    const storage = getDraftStorage();
    if (submissionResult) {
      const completedDraftKey = completedDraftKeyRef.current;
      if (
        completedDraftKey
        && removeApplicationFormDraftSnapshotIfContentKey(draftScope, completedDraftKey, storage)
      ) {
        persistedDraftKeyRef.current = null;
      }
      return;
    }
    const submissionAttempt = submissionAttemptRef.current;
    if (!hasApplicationFormDraftContent(
      form,
      generalOptIn,
      submissionAttempt,
      initialForm(defaultBranch),
    )) {
      removeApplicationFormDraftSnapshot(draftScope, storage);
      persistedDraftKeyRef.current = null;
      return;
    }
    const contentKey = applicationFormDraftContentKey(form, generalOptIn, submissionAttempt);
    if (contentKey === persistedDraftKeyRef.current) return;
    const saved = writeApplicationFormDraftSnapshot(draftScope, {
      form,
      generalOptIn,
      submissionAttempt,
      savedAt: Date.now(),
    }, storage);
    if (saved) persistedDraftKeyRef.current = contentKey;
  }, [
    defaultBranch,
    draftReady,
    draftScope.branch,
    draftScope.job,
    draftScope.source,
    form,
    generalOptIn,
    submissionResult,
  ]);

  useEffect(() => {
    if (jobLoadAttempt === 0) return;
    const pendingIssue = pendingServerValidationRef.current;
    if (pendingIssue && jobLoadState === "loaded") {
      pendingServerValidationRef.current = null;
      requestAnimationFrame(() => {
        const field = document.getElementById(`field-${pendingIssue.field}`);
        const target = field?.querySelector<HTMLElement>("input, select, textarea, button")
          ?? jobTitleRef.current;
        target?.scrollIntoView({ behavior: "auto", block: "center" });
        target?.focus({ preventScroll: true });
      });
      return;
    }
    if (pendingIssue && (jobLoadState === "error" || jobLoadState === "unavailable")) {
      pendingServerValidationRef.current = null;
    }
    if (jobLoadState === "loading") {
      requestAnimationFrame(() => jobLoadingTitleRef.current?.focus({ preventScroll: true }));
    } else if (jobLoadState === "error") {
      requestAnimationFrame(() => retryJobButtonRef.current?.focus({ preventScroll: true }));
    } else if (jobLoadState === "loaded") {
      requestAnimationFrame(() => jobTitleRef.current?.focus({ preventScroll: true }));
    } else if (jobLoadState === "unavailable") {
      requestAnimationFrame(() => unavailableJobTitleRef.current?.focus({ preventScroll: true }));
    }
  }, [jobLoadAttempt, jobLoadState]);

  useEffect(() => {
    if (branchListLoadAttempt === 0) return;
    const pendingIssue = pendingServerValidationRef.current;
    if (branchListLoadState === "loaded" && branches.length > 0) {
      pendingServerValidationRef.current = null;
      requestAnimationFrame(() => {
        if (pendingIssue?.field === "branch2") secondBranchDetailsRef.current?.setAttribute("open", "");
        const field = pendingIssue
          ? document.getElementById(`field-${pendingIssue.field}`)
          : null;
        const target = field?.querySelector<HTMLElement>("input, select, textarea, button")
          ?? document.getElementById("field-branch1")?.querySelector<HTMLElement>("select")
          ?? retryBranchesButtonRef.current;
        target?.scrollIntoView({ behavior: "auto", block: "center" });
        target?.focus({ preventScroll: true });
      });
      return;
    }
    if (
      branchListLoadState === "error"
      || (branchListLoadState === "loaded" && branches.length === 0)
    ) {
      pendingServerValidationRef.current = null;
      requestAnimationFrame(() => retryBranchesButtonRef.current?.focus({ preventScroll: true }));
    }
  }, [branchListLoadAttempt, branchListLoadState, branches.length]);

  useEffect(() => {
    if (!submissionResult) return;
    window.scrollTo({ top: 0, behavior: "auto" });
    requestAnimationFrame(() => successTitleRef.current?.focus({ preventScroll: true }));
  }, [submissionResult]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    if (submitInFlightRef.current) return;
    setError(null);
    if (validationIssue?.field === key) setValidationIssue(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const setPrimaryBranch = (value: string) => {
    if (submitInFlightRef.current) return;
    setError(null);
    if (validationIssue?.field === "branch1") setValidationIssue(null);
    setForm((current) => ({
      ...current,
      branch1: value,
      branch2: current.branch2 === value ? "" : current.branch2,
    }));
  };

  const setOwnVehicle = (value: string) => {
    if (submitInFlightRef.current) return;
    setError(null);
    if (validationIssue?.field === "ownVehicle" || validationIssue?.field === "vehicleType") {
      setValidationIssue(null);
    }
    setForm((current) => ({
      ...current,
      ownVehicle: value,
      vehicleType: value === "있음" ? current.vehicleType : "",
    }));
  };

  const toggleWorkHour = (value: string) => {
    if (submitInFlightRef.current) return;
    setError(null);
    if (validationIssue?.field === "workHours") setValidationIssue(null);
    setForm((prev) => ({
      ...prev,
      workHours: prev.workHours.includes(value)
        ? prev.workHours.filter((v) => v !== value)
        : [...prev.workHours, value],
    }));
  };

  const resetDraft = () => {
    if (submitInFlightRef.current) return;
    submissionAttemptRef.current = null;
    persistedDraftKeyRef.current = null;
    completedDraftKeyRef.current = null;
    pendingServerValidationRef.current = null;
    removeApplicationFormDraftSnapshot(draftScope, getDraftStorage());
    setForm(initialForm(defaultBranch));
    setAddressManualEntry(false);
    setError(null);
    setValidationIssue(null);
    setDraftRestored(false);
    setRecoveryFormVisible(false);
    setResetConfirming(false);
    requestAnimationFrame(() => {
      const target = document.getElementById("name")
        ?? (jobLoadState === "loading" ? jobLoadingTitleRef.current : null)
        ?? (jobLoadState === "error" ? retryJobButtonRef.current : null)
        ?? applicationModeActionRef.current
        ?? unavailableJobTitleRef.current
        ?? jobTitleRef.current;
      target?.scrollIntoView({ behavior: "auto", block: "center" });
      target?.focus({ preventScroll: true });
    });
  };

  const showResetConfirmation = () => {
    setResetConfirming(true);
    requestAnimationFrame(() => keepEditingRef.current?.focus({ preventScroll: true }));
  };

  const cancelResetConfirmation = () => {
    setResetConfirming(false);
    requestAnimationFrame(() => resetDraftTriggerRef.current?.focus({ preventScroll: true }));
  };

  const continueAsGeneralApplication = () => {
    setError(null);
    setGeneralOptIn(true);
    requestAnimationFrame(() => {
      const target = generalJobStatusRef.current ?? generalApplicationTitleRef.current;
      target?.scrollIntoView({ behavior: "auto", block: "center" });
      target?.focus({ preventScroll: true });
    });
  };

  const retryJobLookup = () => {
    setError(null);
    setJobLoadAttempt((attempt) => attempt + 1);
  };

  const retryBranchLookup = () => {
    setError(null);
    setBranchListLoadAttempt((attempt) => attempt + 1);
  };

  const closeAddressSearch = () => {
    setAddressSearchOpen(false);
    addressSearchContainerRef.current?.replaceChildren();
    requestAnimationFrame(() => addressLookupButtonRef.current?.focus({ preventScroll: true }));
  };

  const enableManualAddressEntry = () => {
    if (submitInFlightRef.current) return;
    setAddressManualEntry(true);
    setAddressLookupState("idle");
    requestAnimationFrame(() => locationInputRef.current?.focus({ preventScroll: true }));
  };

  const openRoadAddressLookup = async () => {
    if (submitInFlightRef.current || addressLookupState === "loading") return;
    setError(null);
    setAddressLookupState("loading");
    try {
      await loadKakaoPostcodeScript();
      const Postcode = window.kakao?.Postcode;
      if (!Postcode) throw new Error("postcode constructor missing");
      setAddressSearchOpen(true);
      requestAnimationFrame(() => {
        const container = addressSearchContainerRef.current;
        const recoverFromEmbedFailure = () => {
          setAddressLookupState("error");
          setAddressSearchOpen(false);
          container?.replaceChildren();
          requestAnimationFrame(() => addressLookupButtonRef.current?.focus({ preventScroll: true }));
        };
        if (!container) {
          recoverFromEmbedFailure();
          return;
        }
        container.replaceChildren();
        const embedded = embedApplicantPostcode({
          container,
          create: () => new Postcode({
            oncomplete: (data) => {
              const roadAddress = applicantRoadAddressFromPostcode(data);
              setAddressSearchOpen(false);
              container.replaceChildren();
              if (!roadAddress) {
                setAddressLookupState("idle");
                setValidationIssue({
                  field: "location",
                  message: "도로명 주소가 제공되는 검색 결과를 선택해주세요.",
                });
                requestAnimationFrame(() => addressLookupButtonRef.current?.focus({ preventScroll: true }));
                return;
              }
              setAddressLookupState("idle");
              setAddressManualEntry(false);
              setError(null);
              setValidationIssue((current) => current?.field === "location" ? null : current);
              setForm((current) => ({ ...current, location: roadAddress }));
              requestAnimationFrame(() => {
                const next = document.querySelector<HTMLElement>("#field-ownVehicle button")
                  ?? document.querySelector<HTMLElement>("#field-workHours button");
                next?.scrollIntoView({ behavior: "auto", block: "center" });
                next?.focus({ preventScroll: true });
              });
            },
            onclose: () => {
              setAddressSearchOpen(false);
              container.replaceChildren();
              setAddressLookupState("idle");
              requestAnimationFrame(() => addressLookupButtonRef.current?.focus({ preventScroll: true }));
            },
            onresize: (size) => {
              if (typeof size.height === "number" && Number.isFinite(size.height)) {
                setAddressSearchHeight(Math.min(520, Math.max(360, Math.ceil(size.height))));
              }
            },
            width: "100%",
            height: "100%",
            maxSuggestItems: 5,
          }),
          onError: recoverFromEmbedFailure,
        });
        if (!embedded) return;
        setAddressLookupState("idle");
      });
    } catch {
      setAddressLookupState("error");
      setAddressSearchOpen(false);
      requestAnimationFrame(() => addressLookupButtonRef.current?.focus({ preventScroll: true }));
    }
  };

  const abandonSubmissionAttemptForContextChange = (response: unknown) => {
    const record = response && typeof response === "object"
      ? response as Record<string, unknown>
      : null;
    const responseMessage = typeof record?.error === "string"
      ? record.error
      : "지원 조건이 변경되어 현재 상태를 다시 확인해야 해요.";
    const responseField = typeof record?.field === "string"
      && APPLICATION_ERROR_FIELDS.has(record.field as ApplyFormIssue["field"])
      ? record.field as ApplyFormIssue["field"]
      : null;
    const issue = responseField
      ? { field: responseField, message: responseMessage }
      : null;

    submissionAttemptRef.current = null;
    setRecoveryFormVisible(true);
    setError(`${responseMessage} 작성한 내용은 그대로 저장했어요.`);
    setValidationIssue(issue);
    pendingServerValidationRef.current = issue;

    const storage = getDraftStorage();
    const contentKey = applicationFormDraftContentKey(form, generalOptIn, null);
    const saved = writeApplicationFormDraftSnapshot(draftScope, {
      form,
      generalOptIn,
      submissionAttempt: null,
      savedAt: Date.now(),
    }, storage);
    if (saved) {
      persistedDraftKeyRef.current = contentKey;
    } else {
      removeApplicationFormDraftSnapshot(draftScope, storage);
      persistedDraftKeyRef.current = null;
    }

    if (jobIntent.kind === "job" && !generalOptIn) {
      setJob(null);
      setJobLoadTimedOut(false);
      setJobLoadState("loading");
      setJobLoadAttempt((attempt) => attempt + 1);
    } else if (
      legacyBranchLookupRequired
      && (responseField === null || responseField === "branch1" || responseField === "branch2")
    ) {
      setBranches([]);
      setBranchListLoadState("loading");
      setBranchListLoadAttempt((attempt) => attempt + 1);
    } else if (issue) {
      requestAnimationFrame(() => {
        if (issue.field === "branch2") secondBranchDetailsRef.current?.setAttribute("open", "");
        const field = document.getElementById(`field-${issue.field}`);
        field?.scrollIntoView({ behavior: "auto", block: "center" });
        field?.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
      });
    }
  };

  const handleSubmit = async () => {
    if (submitInFlightRef.current) return;
    if (branchContextLoading || branchChoicesUnavailable) {
      setError(branchContextLoading
        ? "지원 가능한 지점을 확인하고 있어요. 잠시만 기다려주세요."
        : "지원 가능한 지점을 확인하지 못했어요. 다시 불러와주세요.");
      requestAnimationFrame(() => retryBranchesButtonRef.current?.focus({ preventScroll: true }));
      return;
    }
    if (applicationModeChoiceRequired) {
      const target = jobLoadState === "loading"
        ? jobLoadingTitleRef.current
        : jobLoadState === "error"
          ? retryJobButtonRef.current
          : applicationModeActionRef.current;
      target?.scrollIntoView({ behavior: "auto", block: "center" });
      target?.focus({ preventScroll: true });
      return;
    }
    const issue = pendingSubmissionReplay
      ? null
      : validateApplicationSubmission(form, vehicleRequired, branchChoiceRequired);
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
    submitInFlightRef.current = true;
    setSubmittingReplay(pendingSubmissionReplay);
    setSubmitting(true);
    try {
      const prepared = prepareApplicationSubmission(
        submissionAttemptRef.current,
        { ...form, source, jobId: currentSubmissionJobId },
        currentVehicleRequired,
        () => crypto.randomUUID(),
      );
      submissionAttemptRef.current = prepared.attempt;
      const preparedDraftKey = applicationFormDraftContentKey(form, generalOptIn, prepared.attempt);
      const saved = writeApplicationFormDraftSnapshot(draftScope, {
        form,
        generalOptIn,
        submissionAttempt: prepared.attempt,
        savedAt: Date.now(),
      }, getDraftStorage());
      if (saved) persistedDraftKeyRef.current = preparedDraftKey;
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
        if (shouldAbandonApplicationSubmissionAttempt(json)) {
          abandonSubmissionAttemptForContextChange(json);
          return;
        }
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
      completedDraftKeyRef.current = preparedDraftKey;
      if (removeApplicationFormDraftSnapshotIfContentKey(
        draftScope,
        preparedDraftKey,
        getDraftStorage(),
      )) {
        persistedDraftKeyRef.current = null;
      }
      setSubmissionResult(json);
    } catch (submitError) {
      setError(isRequestTimeoutError(submitError)
        ? "응답이 늦어 접수 결과를 확인하지 못했어요. 같은 내용으로 다시 시도하면 중복 접수 없이 상태를 다시 확인합니다."
        : "인터넷 연결을 확인한 뒤 같은 내용으로 다시 시도해주세요. 제출 내용이 같으면 중복 접수되지 않아요.");
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
      setSubmittingReplay(false);
    }
  };

  const progress = applicationSubmissionProgress(form, vehicleRequired, branchChoiceRequired);
  const showApplyForm = recoverySessionActive || currentApplyFormAvailable;
  const hasUnavailableJobLink = !replayUiActive
    && (jobIntent.kind === "invalid" || jobLoadState === "unavailable");
  const invalidField = validationIssue?.field ?? null;
  const fieldA11y = (field: keyof FormState, descriptionId?: string) => ({
    "aria-invalid": invalidField === field ? true : undefined,
    "aria-describedby": [
      descriptionId,
      invalidField === field ? fieldErrorId(field) : null,
    ].filter(Boolean).join(" ") || undefined,
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
            <p className="mt-5 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[15px] font-bold leading-relaxed text-warning-strong">
              이 공고의 검토 목록에는 다시 추가되지 않았어요. 기본 지원 정보만 업데이트됐고, 이 공고의 이전 처리 결과는 그대로 유지됩니다.
            </p>
          )}
          {completionKind === "general_job_unavailable" && (
            <p className="mt-5 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[15px] font-bold leading-relaxed text-warning-strong">
              선택한 공고에는 연결되지 않았고, 작성한 내용은 다른 일자리 검토용 지원서로 접수됐어요.
            </p>
          )}
          {completionKind === "general_job_failed" && (
            <p className="mt-5 rounded-2xl border border-error/25 bg-error-soft px-4 py-3 text-[15px] font-bold leading-relaxed text-error-strong">
              선택한 공고와의 연결 여부는 매니저 확인이 필요해요. {initialMessageState === "sent"
                ? "방금 받은 안내 문자에 답장해 알려주세요."
                : initialMessageState === "uncertain"
                  ? "안내 문자 발송 여부를 확인하지 못했어요. 잠시 뒤 문자 수신 여부를 확인해주세요."
                : "기존에 받은 문자 대화가 있다면 답장하거나 잠시 후 다시 확인해주세요."}
            </p>
          )}
          <p className="mt-5 border-t border-border pt-4 text-[15px] font-medium leading-relaxed text-muted-foreground">
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
            <h1 className="text-[22px] font-extrabold text-foreground">배송원 지원</h1>
          </div>
          <p className="text-[16px] text-muted-foreground">
            {replayUiActive ? (
              <>이전에 보낸 지원서의 접수 결과를 다시 확인할게요.</>
            ) : applicationModeChoiceRequired ? (
              <>수정한 내용은 저장되어 있어요. 위에서 지원 방식을 확인해주세요.</>
            ) : showApplyForm ? (
              <>필수 항목은 <span aria-hidden="true" className="text-error-strong">*</span><span className="sr-only">별표</span>로 표시했어요.</>
            ) : (
              <>문자로 받으신 공고 상태를 먼저 확인할게요.</>
            )}
          </p>
        </div>

        {!replayUiActive && jobIntent.kind === "job" && jobLoadState === "loading" && (
          <section role="status" aria-live="polite" className="mb-6 flex items-center gap-3 rounded-2xl border border-border-strong bg-card px-5 py-5 shadow-sm">
            <Loader2 size={22} aria-hidden="true" className="shrink-0 animate-spin text-warning-strong motion-reduce:animate-none" />
            <div className="text-left">
              <h2 ref={jobLoadingTitleRef} tabIndex={-1} className="text-[16px] font-extrabold text-foreground">지원할 공고를 확인하고 있어요</h2>
              <p className="mt-1 text-[15px] leading-relaxed text-muted-foreground">확인되면 지원서를 바로 보여드릴게요.</p>
            </div>
          </section>
        )}

        {!replayUiActive && !generalOptIn && jobLoadState === "error" && (
          <section role="alert" className="mb-6 rounded-2xl border border-warning/30 bg-card px-5 py-5 shadow-sm">
            <div className="flex items-start gap-3">
              <AlertCircle size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-warning-strong" />
              <div>
                <h2 className="text-[17px] font-extrabold text-foreground">공고 상태를 확인하지 못했어요</h2>
                <p className="mt-1 text-[15px] leading-relaxed text-muted-foreground">
                  {applyJobLoadErrorDescription(jobLoadTimedOut)}
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <button
                ref={retryJobButtonRef}
                type="button"
                onClick={retryJobLookup}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-foreground px-4 text-[16px] font-extrabold text-white transition-colors hover:bg-foreground/90 active:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <RefreshCw size={18} aria-hidden="true" /> 다시 불러오기
              </button>
              <button
                ref={applicationModeActionRef}
                type="button"
                onClick={continueAsGeneralApplication}
                className="min-h-12 rounded-2xl border border-control-border bg-card px-4 text-[16px] font-bold text-foreground transition-colors hover:bg-muted active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                공고 없이 일반 지원서 작성
              </button>
            </div>
          </section>
        )}

        {!generalOptIn && hasUnavailableJobLink && (
          <section role="alert" className="mb-6 rounded-2xl border border-error/30 bg-card px-5 py-5 shadow-sm">
            <div className="flex items-start gap-3">
              <AlertCircle size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-error-strong" />
              <div>
                <h2 ref={unavailableJobTitleRef} tabIndex={-1} className="text-[17px] font-extrabold text-foreground">이 공고 링크를 확인할 수 없어요</h2>
                <p className="mt-1 text-[15px] leading-relaxed text-muted-foreground">주소가 잘못됐거나 더 이상 공개되지 않는 공고일 수 있어요.</p>
              </div>
            </div>
            <button
              ref={applicationModeActionRef}
              type="button"
              onClick={continueAsGeneralApplication}
              className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand-yellow px-4 text-[16px] font-extrabold text-foreground shadow-brand transition-colors hover:bg-yellow-500 active:bg-yellow-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <FileText size={18} aria-hidden="true" /> 다른 일자리 지원서 작성하기
            </button>
            <p className="mt-3 text-center text-[15px] leading-relaxed text-muted-foreground">받으신 문자에 답장하시면 매니저가 링크를 확인해드려요.</p>
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
                <h2 ref={jobTitleRef} tabIndex={-1} className="mt-1 text-[18px] font-extrabold leading-snug text-foreground">{verifiedJob.title}</h2>
                <p className="mt-1 text-[14px] text-muted-foreground">
                  {[verifiedJob.client_name, verifiedJob.branch].filter(Boolean).join(" · ") || "옹고잉 배송원"}
                </p>
              </div>
            </div>
            {replayUiActive ? (
              <p className="mt-4 rounded-xl border border-info/20 bg-info-soft px-3 py-2.5 text-[15px] font-bold leading-relaxed text-info-strong">
                새로 지원하는 것이 아니라, 이전에 보낸 지원서의 접수 결과를 같은 접수번호로 다시 확인합니다.
              </p>
            ) : generalOptIn ? (
              <p ref={generalJobStatusRef} tabIndex={-1} role="status" aria-live="polite" className="mt-4 flex items-start gap-2 rounded-xl border border-info/20 bg-info-soft px-3 py-2.5 text-[15px] font-bold leading-relaxed text-info-strong">
                <FileText size={17} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>지금부터 작성하는 내용은 다른 일자리용 일반 지원서로 접수됩니다.</span>
              </p>
            ) : verifiedJob.recruiting ? (
              <p className="mt-4 rounded-xl border border-success/20 bg-success-soft px-3 py-2.5 text-[15px] font-bold leading-relaxed text-success-strong">
                아래 지원서를 제출하면 이 공고에 지원 의사가 전달됩니다. 근무 확정은 아니며, 매니저가 확인합니다.
              </p>
            ) : (
              <div className="mt-4 rounded-xl border border-error/25 bg-error-soft px-3 py-3">
                <p className="text-[15px] font-bold leading-relaxed text-error-strong">이 공고에는 더 이상 지원할 수 없어요. 원하시면 다른 일자리용 지원서를 남길 수 있어요.</p>
                <button
                  ref={applicationModeActionRef}
                  type="button"
                  onClick={continueAsGeneralApplication}
                  className="mt-3 min-h-12 w-full rounded-xl bg-foreground px-4 text-[15px] font-extrabold text-white transition-colors hover:bg-foreground/90 active:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  다른 일자리 지원서 작성하기
                </button>
              </div>
            )}
          </section>
        )}

        {!replayUiActive && generalOptIn && !verifiedJob && (
          <section role="status" aria-live="polite" className="mb-6 flex items-start gap-3 rounded-2xl border border-info/20 bg-info-soft px-5 py-4 text-info-strong">
            <FileText size={20} aria-hidden="true" className="mt-0.5 shrink-0" />
            <div>
              <h2 ref={generalApplicationTitleRef} tabIndex={-1} className="text-[16px] font-extrabold">다른 일자리용 지원서를 작성하고 있어요</h2>
              <p className="mt-1 text-[15px] font-medium leading-relaxed">작성하신 조건에 맞는 일자리를 매니저가 확인합니다.</p>
            </div>
          </section>
        )}

        {showApplyForm && !draftReady && (
          <section role="status" aria-live="polite" className="mb-6 flex items-center gap-3 rounded-2xl border border-border-strong bg-card px-5 py-5 shadow-sm">
            <Loader2 size={22} aria-hidden="true" className="shrink-0 animate-spin text-warning-strong motion-reduce:animate-none" />
            <div className="text-left">
              <h2 className="text-[16px] font-extrabold text-foreground">지원서를 준비하고 있어요</h2>
              <p className="mt-1 text-[15px] leading-relaxed text-muted-foreground">이 탭에 작성 중인 내용이 있는지 확인할게요.</p>
            </div>
          </section>
        )}

        {showApplyForm && draftReady && <form
          aria-busy={submitting}
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
        <fieldset
          disabled={submitting}
          className={`m-0 min-w-0 border-0 p-0 ${submitting ? "[&_button]:cursor-wait [&_button]:opacity-60 [&_input]:cursor-wait [&_select]:cursor-wait [&_textarea]:cursor-wait" : ""}`}
        >
        {draftRestored && (
          <section role="status" aria-live="polite" aria-atomic="true" className="mb-5 rounded-2xl border border-info/20 bg-info-soft px-4 py-4 text-info-strong">
            {resetConfirming ? (
              <>
                <h2 className="text-[16px] font-extrabold">
                  {replayUiActive ? "이전 접수 결과 재확인을 중단할까요?" : "불러온 내용을 모두 지울까요?"}
                </h2>
                <p className="mt-1 text-[15px] font-medium leading-relaxed">
                  {replayUiActive
                    ? "불러온 내용과 같은 접수번호로 결과를 다시 확인할 수 없게 됩니다."
                    : "입력한 내용은 복구할 수 없어요."}
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <button
                    ref={keepEditingRef}
                    type="button"
                    onClick={cancelResetConfirmation}
                    className="min-h-12 rounded-xl border border-info/25 bg-card px-4 text-[15px] font-bold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    계속 작성
                  </button>
                  <button
                    type="button"
                    onClick={resetDraft}
                    className="min-h-12 rounded-xl bg-error-strong px-4 text-[15px] font-extrabold text-white transition-colors hover:bg-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2"
                  >
                    모두 지우기
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-3">
                  <FileText size={20} aria-hidden="true" className="mt-0.5 shrink-0" />
                  <div>
                    <h2 className="text-[16px] font-extrabold">
                      {replayUiActive
                        ? "접수 결과가 확인되지 않은 지원서를 불러왔어요"
                        : applicationModeChoiceRequired
                          ? "수정한 내용은 안전하게 저장되어 있어요"
                          : "작성하던 내용을 불러왔어요"}
                    </h2>
                    <p className="mt-1 text-[15px] font-medium leading-relaxed">
                      {replayUiActive
                        ? "내용을 그대로 두고 아래 버튼을 누르면 중복 접수 없이 이전 결과를 다시 확인합니다. 내용을 바꾸면 현재 공고 상태에 맞는 새 지원으로 전환됩니다."
                        : applicationModeChoiceRequired
                          ? "내용이 바뀌어 새 지원으로 전환됐어요. 위에서 공고를 다시 확인하거나 다른 일자리용 일반 지원을 선택해주세요."
                          : "확인한 뒤 이어서 작성해주세요."}
                    </p>
                  </div>
                </div>
                <div className="mt-2 flex justify-end">
                  <button
                    ref={resetDraftTriggerRef}
                    type="button"
                    onClick={showResetConfirmation}
                    className="inline-flex min-h-11 items-center rounded-xl px-3 text-[15px] font-bold text-info-strong underline decoration-info/40 underline-offset-4 transition-colors hover:bg-info/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    처음부터 작성
                  </button>
                </div>
              </>
            )}
          </section>
        )}
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
              aria-valuetext={`필수 ${progress.total}개 중 ${progress.completed}개 완료`}
            >
              <div className="h-full rounded-full bg-brand-yellow transition-[width] motion-reduce:transition-none" style={{ width: `${progress.percent}%` }} />
            </div>
            {error && (
              <div role="alert" aria-live="assertive" className="mt-3 flex items-start gap-2 border-t border-error/20 pt-3 text-[15px] font-bold text-error-strong">
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
              <p className="mt-0.5 text-[15px] leading-relaxed text-muted-foreground">연락과 근무지 안내에 필요한 정보예요.</p>
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
            <label htmlFor="birthDate" className={labelCls}>생년월일{requiredMark}</label>
            <input
              id="birthDate"
              name="birthDate"
              aria-required="true"
              {...fieldA11y("birthDate", "birthDate-help")}
              className={fieldInputClass("birthDate")}
              inputMode="numeric"
              maxLength={6}
              enterKeyHint="next"
              value={form.birthDate}
              onChange={(e) => set("birthDate", digits(e.target.value, 6))}
              onBlur={() => {
                if (form.birthDate && !isValidApplicantBirthDate(form.birthDate)) {
                  setValidationIssue({ field: "birthDate", message: APPLICANT_BIRTH_DATE_ERROR_MESSAGE });
                }
              }}
              placeholder="예: 600101"
            />
            <p id="birthDate-help" className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
              1960년 1월 1일은 600101로 입력해주세요. 주민등록번호 뒤 7자리는 입력하지 마세요.
            </p>
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
            <label htmlFor="location" className={labelCls}>거주지 도로명 주소{requiredMark}</label>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <div className="relative min-w-0">
                <MapPin aria-hidden="true" size={19} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={locationInputRef}
                  id="location"
                  name="location"
                  autoComplete="address-line1"
                  aria-required="true"
                  readOnly={!addressManualEntry}
                  {...fieldA11y("location", "location-help")}
                  className={fieldInputClass("location", addressManualEntry ? "pl-11" : "cursor-default pl-11")}
                  value={form.location}
                  onChange={(event) => set("location", event.target.value)}
                  onBlur={() => {
                    if (form.location && !isValidApplicantRoadAddress(form.location)) {
                      setValidationIssue({
                        field: "location",
                        message: APPLICANT_ROAD_ADDRESS_ERROR_MESSAGE,
                      });
                    }
                  }}
                  placeholder={addressManualEntry
                    ? "예: 서울 강남구 테헤란로 123"
                    : "주소 찾기로 선택해주세요"}
                />
              </div>
              <button
                ref={addressLookupButtonRef}
                type="button"
                aria-controls="road-address-search"
                aria-expanded={addressSearchOpen}
                disabled={addressLookupState === "loading" || submitting}
                onClick={openRoadAddressLookup}
                className="inline-flex min-h-12 items-center justify-center gap-1.5 rounded-2xl border border-foreground bg-foreground px-4 text-[15px] font-extrabold text-white transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
              >
                {addressLookupState === "loading"
                  ? <Loader2 aria-hidden="true" size={18} className="animate-spin motion-reduce:animate-none" />
                  : <Search aria-hidden="true" size={18} />}
                {form.location ? "다시 찾기" : "주소 찾기"}
              </button>
            </div>
            <p id="location-help" className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
              {addressManualEntry
                ? "도로명과 건물번호까지만 입력해주세요. 아파트 동·호수나 층은 받지 않아요."
                : "검색 결과의 도로명과 건물번호만 저장합니다. 아파트 동·호수나 층은 받지 않아요."}
            </p>
            {addressLookupState === "error" && (
              <div className="mt-2 rounded-xl border border-error/20 bg-error-soft px-3 py-3">
                <p role="alert" className="flex items-start gap-1.5 text-[15px] font-bold leading-relaxed text-error-strong">
                  <AlertCircle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
                  주소 검색을 열지 못했어요. 다시 시도하거나 도로명 주소를 직접 입력해주세요.
                </p>
                {!addressManualEntry && (
                  <button
                    type="button"
                    onClick={enableManualAddressEntry}
                    className="mt-2 inline-flex min-h-11 items-center rounded-xl border border-error/30 bg-card px-3 text-[15px] font-extrabold text-error-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    도로명 주소 직접 입력
                  </button>
                )}
              </div>
            )}
            <FieldError field="location" issue={validationIssue} />
            <div
              id="road-address-search"
              role="region"
              aria-label="도로명 주소 검색"
              className={addressSearchOpen
                ? "mt-3 overflow-hidden rounded-2xl border border-border-strong bg-card shadow-sm"
                : "hidden"}
            >
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4">
                <span className="text-[15px] font-extrabold text-foreground">도로명 주소 검색</span>
                <button
                  type="button"
                  onClick={closeAddressSearch}
                  aria-label="주소 검색 닫기"
                  className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X aria-hidden="true" size={20} />
                </button>
              </div>
              <div
                ref={addressSearchContainerRef}
                style={{ height: `${addressSearchHeight}px` }}
                className="w-full bg-white"
              />
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-7 rounded-2xl border border-border-strong bg-card p-5 shadow-sm sm:p-8 landscape:p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-[14px] font-extrabold text-white">2</span>
            <div>
              <h2 className="text-[18px] font-extrabold text-foreground">차량·면허</h2>
              <p className="mt-0.5 text-[15px] leading-relaxed text-muted-foreground">
                {vehicleRequired
                  ? "현재 보유한 차량과 면허 정보를 알려주세요."
                  : "이 공고는 본인 차량이나 운전면허 없이 지원할 수 있어요."}
              </p>
            </div>
          </div>

          {vehicleRequired ? (
            <>
              {/* 자차 보유 */}
              <div id="field-ownVehicle">
                <div id="ownVehicle-label" className={labelCls}>자차(본인 차량) 보유{requiredMark}</div>
                <div role="group" aria-labelledby="ownVehicle-label" {...fieldA11y("ownVehicle")} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {["있음", "없음"].map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      aria-pressed={form.ownVehicle === opt}
                      {...fieldA11y("ownVehicle")}
                      onClick={() => setOwnVehicle(opt)}
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

              {form.ownVehicle === "있음" && (
                <div id="field-vehicleType">
                  <label htmlFor="vehicleType" className={labelCls}>보유 차종{requiredMark}</label>
                  <input
                    id="vehicleType"
                    name="vehicleType"
                    aria-required="true"
                    {...fieldA11y("vehicleType", "vehicleType-help")}
                    className={fieldInputClass("vehicleType")}
                    value={form.vehicleType}
                    onChange={(event) => set("vehicleType", event.target.value)}
                    placeholder="예: 모닝 / 아반떼 / 스타렉스 / 포터"
                  />
                  <p id="vehicleType-help" className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
                    배송에 사용할 차량 모델명을 입력해주세요.
                  </p>
                  <FieldError field="vehicleType" issue={validationIssue} />
                </div>
              )}
            </>
          ) : (
            <div className="rounded-2xl border border-success/20 bg-success-soft px-4 py-3 text-[15px] font-bold leading-relaxed text-success-strong">
              차량·면허·본인 명의 조건은 이 공고의 필수 항목이 아니므로 입력하지 않아도 됩니다.
            </div>
          )}
        </div>

        <div className="mt-5 flex flex-col gap-7 rounded-2xl border border-border-strong bg-card p-5 shadow-sm sm:p-8 landscape:p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-[14px] font-extrabold text-white">3</span>
            <div>
              <h2 className="text-[18px] font-extrabold text-foreground">희망 근무·정산 조건</h2>
              <p className="mt-0.5 text-[15px] leading-relaxed text-muted-foreground">
                {branchMode === "fixed"
                  ? jobBranchContextActive
                    ? "이 공고의 근무지를 확인하고, 가능한 시간과 시작일을 알려주세요."
                    : "안내받은 근무지를 확인하고, 가능한 시간과 시작일을 알려주세요."
                  : branchMode === "choice"
                    ? "실제 운영 중인 지점과 가능한 시간, 시작일을 선택해주세요."
                    : "원하는 근무 시간과 시작 가능일을 선택해주세요."}
              </p>
            </div>
          </div>

          {branchMode === "fixed" && fixedBranch && (
            <dl className="rounded-2xl border border-info/20 bg-info-soft px-4 py-4">
              <dt className="text-[14px] font-bold text-info-strong">지원 근무지</dt>
              <dd className="mt-1 text-[18px] font-extrabold text-foreground">{fixedBranch}</dd>
              <dd className="mt-1 text-[14px] font-medium leading-relaxed text-muted-foreground">
                {jobBranchContextActive
                  ? "공고에 정해진 근무지라 지원서에서 따로 선택하지 않아도 됩니다."
                  : "안내 링크에 정해진 근무지라 지원서에서 따로 선택하지 않아도 됩니다."}
              </dd>
            </dl>
          )}

          {branchMode === "choice" && (
            <div id="field-branch1">
              {branchChoicesLoading ? (
                <div role="status" aria-live="polite" className="flex min-h-16 items-center gap-3 rounded-2xl border border-border bg-muted/30 px-4 py-3">
                  <Loader2 size={20} aria-hidden="true" className="shrink-0 animate-spin text-warning-strong motion-reduce:animate-none" />
                  <span className="text-[15px] font-bold text-foreground">지원 가능한 지점을 확인하고 있어요.</span>
                </div>
              ) : branchChoicesUnavailable ? (
                <div role="alert" className="rounded-2xl border border-warning/30 bg-warning-soft px-4 py-4">
                  <p className="text-[15px] font-bold leading-relaxed text-warning-strong">
                    지원 가능한 지점을 확인하지 못했어요. 임의의 지점을 입력하지 않고 목록을 다시 확인합니다.
                  </p>
                  <button
                    ref={retryBranchesButtonRef}
                    type="button"
                    onClick={retryBranchLookup}
                    className="mt-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-warning/30 bg-card px-4 text-[15px] font-extrabold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <RefreshCw size={18} aria-hidden="true" /> 지점 다시 불러오기
                  </button>
                </div>
              ) : (
                <>
                  <label htmlFor="branch1" className={labelCls}>희망 지점 (1순위){requiredMark}</label>
                  <select
                    id="branch1"
                    name="branch1"
                    aria-required="true"
                    {...fieldA11y("branch1", "branch1-help")}
                    className={fieldInputClass("branch1")}
                    value={form.branch1}
                    onChange={(event) => setPrimaryBranch(event.target.value)}
                  >
                    <option value="">선택해주세요</option>
                    {hasSubmissionAttempt && form.branch1 && !branchOptions.includes(form.branch1) && (
                      <option value={form.branch1}>{form.branch1}</option>
                    )}
                    {branchOptions.map((branch) => (
                      <option key={branch} value={branch}>{branch}</option>
                    ))}
                  </select>
                  <p id="branch1-help" className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
                    해당 화주사에서 실제 운영 중인 지점만 표시합니다.
                  </p>
                  <FieldError field="branch1" issue={validationIssue} />

                  <details ref={secondBranchDetailsRef} className="group mt-4 overflow-hidden rounded-2xl border border-border bg-muted/30">
                    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[15px] font-bold text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                      <span>다른 희망 지점 추가 <span className="font-medium text-muted-foreground">(선택)</span></span>
                      <ChevronDown size={18} aria-hidden="true" className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
                    </summary>
                    <div id="field-branch2" className="border-t border-border px-4 pb-4 pt-3">
                      <label htmlFor="branch2" className={labelCls}>희망 지점 (2순위)</label>
                      <select
                        id="branch2"
                        name="branch2"
                        {...fieldA11y("branch2")}
                        className={fieldInputClass("branch2")}
                        value={form.branch2}
                        onChange={(event) => set("branch2", event.target.value)}
                      >
                        <option value="">선택 안 함</option>
                        {hasSubmissionAttempt && form.branch2 && !branchOptions.includes(form.branch2) && (
                          <option value={form.branch2}>{form.branch2}</option>
                        )}
                        {branchOptions.filter((branch) => branch !== form.branch1).map((branch) => (
                          <option key={branch} value={branch}>{branch}</option>
                        ))}
                      </select>
                      <FieldError field="branch2" issue={validationIssue} />
                    </div>
                  </details>
                </>
              )}
            </div>
          )}

          {/* 희망 근무 시간대 */}
          <div id="field-workHours">
            <div id="workHours-label" className={labelCls}>희망 근무 시간대 (1개 이상 선택){requiredMark}</div>
            <div role="group" aria-labelledby="workHours-label" {...fieldA11y("workHours")} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                      <div className="text-[15px] text-muted-foreground">{slot.sub}</div>
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
              <div role="group" aria-labelledby="selfOwnership-label" {...fieldA11y("selfOwnership")} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <p className="mt-0.5 text-[15px] leading-relaxed text-muted-foreground">경력이나 소개를 남기고 싶을 때만 작성해주세요.</p>
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
              <span className="py-2 text-[15px] leading-relaxed text-gray-700">채용·근무 관련 안내 문자 수신에 동의합니다. (선택)</span>
            </label>
          </div>
        </details>

        <button
          type="submit"
          disabled={submitting || waitingForApplicationContext}
          className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full mt-4 min-h-14 bg-brand-yellow hover:bg-yellow-500 disabled:cursor-wait disabled:opacity-60 text-foreground px-4 py-4 rounded-2xl text-[16px] font-extrabold transition-colors flex items-center justify-center gap-2 shadow-brand"
        >
          {submitting || waitingForApplicationContext
            ? <Loader2 size={20} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            : null}
          {waitingForApplicationContext
            ? branchContextLoading
              ? "근무지 확인 중…"
              : branchChoicesUnavailable
                ? "지점 확인 필요"
                : "공고 확인 중…"
            : submitting
            ? submittingReplay ? "접수 결과 확인 중…" : "제출 중…"
            : applicationModeChoiceRequired
              ? "지원 방식 확인하기"
              : replayUiActive ? "접수 결과 다시 확인" : submissionJobId ? "이 공고에 지원하기" : "지원서 제출하기"}
        </button>
        {submitting && (
          <p role="status" aria-live="polite" className="mt-3 text-center text-[15px] font-bold leading-relaxed text-muted-foreground">
            {submittingReplay
              ? "이전 접수 결과를 확인하고 있어요. 잠시만 기다려주세요."
              : "지원서를 제출하고 있어요. 잠시만 기다려주세요."}
          </p>
        )}
        </fieldset>
        </form>}
        <div className="h-10" />
      </div>
    </div>
  );
}

function ApplyFormRoute() {
  const searchParams = useSearchParams();
  const source = normalizeSource(searchParams.get("source"));
  const prefillBranch = searchParams.get("branch");
  const jobParam = searchParams.get("job");
  const draftScope: ApplicationFormDraftScope = {
    source,
    job: jobParam,
    branch: prefillBranch,
  };
  const scopeKey = applicationFormDraftStorageKey(draftScope);

  return (
    <ApplyForm
      key={scopeKey}
      source={source}
      prefillBranch={prefillBranch}
      jobParam={jobParam}
      draftScope={draftScope}
    />
  );
}

export default function ApplyPage() {
  return (
    <Suspense fallback={(
      <div className="min-h-dvh bg-background px-4 py-6 sm:px-5 sm:py-10">
        <div role="status" aria-live="polite" className="mx-auto flex max-w-[560px] items-center gap-3 rounded-2xl border border-border-strong bg-card px-5 py-5 shadow-sm">
          <Loader2 size={22} aria-hidden="true" className="shrink-0 animate-spin text-warning-strong motion-reduce:animate-none" />
          <div>
            <p className="text-[16px] font-extrabold text-foreground">지원서를 준비하고 있어요</p>
            <p className="mt-1 text-[15px] leading-relaxed text-muted-foreground">잠시만 기다려주세요.</p>
          </div>
        </div>
      </div>
    )}>
      <ApplyFormRoute />
    </Suspense>
  );
}
