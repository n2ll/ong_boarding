import type { ApplicantFormData } from "./applicant-form";
import type { ApplicationSubmissionAttempt } from "./application-submission";

const STORAGE_PREFIX = "ongboarding:application-form-draft:v1";
const MAX_AGE_MS = 8 * 60 * 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ApplicationFormDraftScope {
  source: string;
  job: string | number | null;
  branch: string | null;
}

export interface ApplicationFormDraftSnapshot {
  form: ApplicantFormData;
  generalOptIn: boolean;
  submissionAttempt: ApplicationSubmissionAttempt | null;
  savedAt: number;
}

export interface ApplicationFormDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredApplicationFormDraftSnapshot extends ApplicationFormDraftSnapshot {
  version: 2;
}

const FORM_STRING_FIELDS: Array<Exclude<keyof ApplicantFormData, "workHours" | "marketingConsent">> = [
  "name",
  "birthDate",
  "phone",
  "location",
  "ownVehicle",
  "licenseType",
  "vehicleType",
  "branch1",
  "branch2",
  "experience",
  "introduction",
  "availableDate",
  "selfOwnership",
];

function normalizedText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

function normalizedJob(
  value: ApplicationFormDraftScope["job"],
): readonly ["general"] | readonly ["job", number] | readonly ["invalid", string] {
  if (value === null) return ["general"];
  const untrimmed = String(value).normalize("NFC");
  const raw = normalizedText(untrimmed);
  if (untrimmed !== raw) return ["invalid", raw];
  if (/^[1-9]\d*$/.test(raw)) {
    const id = Number(raw);
    if (Number.isSafeInteger(id)) return ["job", id];
  }
  return ["invalid", raw];
}

export function applicationFormDraftStorageKey(scope: ApplicationFormDraftScope): string {
  const source = normalizedText(scope.source).toLowerCase() || "direct";
  const branch = scope.branch ? normalizedText(scope.branch) || null : null;
  return `${STORAGE_PREFIX}:${encodeURIComponent(JSON.stringify([source, normalizedJob(scope.job), branch]))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isApplicantFormData(value: unknown): value is ApplicantFormData {
  if (!isRecord(value)) return false;
  return FORM_STRING_FIELDS.every((field) => typeof value[field] === "string")
    && Array.isArray(value.workHours)
    && value.workHours.every((slot) => typeof slot === "string")
    && (typeof value.marketingConsent === "boolean" || value.marketingConsent === null);
}

export function hasApplicationFormDraftContent(
  form: ApplicantFormData,
  generalOptIn: boolean,
  submissionAttempt: ApplicationSubmissionAttempt | null,
  baseline?: ApplicantFormData,
): boolean {
  if (generalOptIn || submissionAttempt) return true;
  const base = baseline;
  if (FORM_STRING_FIELDS.some((field) => form[field] !== (base?.[field] ?? ""))) return true;
  if (form.marketingConsent !== (base?.marketingConsent ?? null)) return true;
  const baseWorkHours = base?.workHours ?? [];
  return form.workHours.length !== baseWorkHours.length
    || form.workHours.some((slot, index) => slot !== baseWorkHours[index]);
}

export function applicationFormDraftContentKey(
  form: ApplicantFormData,
  generalOptIn: boolean,
  submissionAttempt: ApplicationSubmissionAttempt | null,
): string {
  return JSON.stringify([
    FORM_STRING_FIELDS.map((field) => form[field]),
    form.workHours,
    form.marketingConsent,
    generalOptIn,
    submissionAttempt?.fingerprint ?? null,
    submissionAttempt?.id ?? null,
    submissionAttempt?.jobId ?? null,
    submissionAttempt?.vehicleRequired ?? null,
  ]);
}

function isSubmissionAttempt(value: unknown): value is ApplicationSubmissionAttempt {
  return isRecord(value)
    && typeof value.fingerprint === "string"
    && value.fingerprint.length > 0
    && typeof value.id === "string"
    && UUID_PATTERN.test(value.id)
    && (value.jobId === null || (
      typeof value.jobId === "number"
      && Number.isSafeInteger(value.jobId)
      && value.jobId > 0
    ))
    && typeof value.vehicleRequired === "boolean";
}

function isSnapshot(value: unknown): value is ApplicationFormDraftSnapshot {
  return isRecord(value)
    && isApplicantFormData(value.form)
    && typeof value.generalOptIn === "boolean"
    && (value.submissionAttempt === null || isSubmissionAttempt(value.submissionAttempt))
    && typeof value.savedAt === "number"
    && Number.isFinite(value.savedAt)
    && value.savedAt >= 0;
}

function parseSnapshot(raw: string): ApplicationFormDraftSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed)
    || (parsed.version !== 1 && parsed.version !== 2)
    || !isSnapshot(parsed)
  ) return null;
  const marketingConsent = parsed.version === 1 && parsed.form.marketingConsent === false
    ? null
    : parsed.form.marketingConsent;
  return {
    form: {
      name: parsed.form.name,
      birthDate: parsed.form.birthDate,
      phone: parsed.form.phone,
      location: parsed.form.location,
      ownVehicle: parsed.form.ownVehicle,
      licenseType: parsed.form.licenseType,
      vehicleType: parsed.form.vehicleType,
      branch1: parsed.form.branch1,
      branch2: parsed.form.branch2,
      workHours: [...parsed.form.workHours],
      experience: parsed.form.experience,
      introduction: parsed.form.introduction,
      availableDate: parsed.form.availableDate,
      selfOwnership: parsed.form.selfOwnership,
      marketingConsent,
    },
    generalOptIn: parsed.generalOptIn,
    submissionAttempt: parsed.submissionAttempt === null
      ? null
      : {
          fingerprint: parsed.submissionAttempt.fingerprint,
          id: parsed.submissionAttempt.id,
          jobId: parsed.submissionAttempt.jobId,
          vehicleRequired: parsed.submissionAttempt.vehicleRequired,
        },
    savedAt: parsed.savedAt,
  };
}

function removeQuietly(key: string, storage: ApplicationFormDraftStorage): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage 차단이 지원서 작성을 막아서는 안 된다.
  }
}

export function readApplicationFormDraftSnapshot(
  scope: ApplicationFormDraftScope,
  storage: ApplicationFormDraftStorage | null,
  now: number = Date.now(),
): ApplicationFormDraftSnapshot | null {
  if (!storage) return null;
  const key = applicationFormDraftStorageKey(scope);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const snapshot = parseSnapshot(raw);
    if (!snapshot || snapshot.savedAt > now || now - snapshot.savedAt > MAX_AGE_MS) {
      removeQuietly(key, storage);
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

export function writeApplicationFormDraftSnapshot(
  scope: ApplicationFormDraftScope,
  snapshot: ApplicationFormDraftSnapshot,
  storage: ApplicationFormDraftStorage | null,
): boolean {
  if (!storage || !isSnapshot(snapshot)) return false;
  const stored: StoredApplicationFormDraftSnapshot = { version: 2, ...snapshot };
  try {
    storage.setItem(applicationFormDraftStorageKey(scope), JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

export function removeApplicationFormDraftSnapshot(
  scope: ApplicationFormDraftScope,
  storage: ApplicationFormDraftStorage | null,
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(applicationFormDraftStorageKey(scope));
    return true;
  } catch {
    return false;
  }
}

export function removeApplicationFormDraftSnapshotIfContentKey(
  scope: ApplicationFormDraftScope,
  expectedContentKey: string,
  storage: ApplicationFormDraftStorage | null,
): boolean {
  if (!storage) return false;
  const key = applicationFormDraftStorageKey(scope);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return true;
    const snapshot = parseSnapshot(raw);
    if (!snapshot) {
      storage.removeItem(key);
      return true;
    }
    const currentContentKey = applicationFormDraftContentKey(
      snapshot.form,
      snapshot.generalOptIn,
      snapshot.submissionAttempt,
    );
    if (currentContentKey !== expectedContentKey) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
