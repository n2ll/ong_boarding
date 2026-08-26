export const JOB_CREATE_DRAFT_STORAGE_KEY = "ongboarding:job-create-draft:v1";
export const JOB_CREATE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

type SelectId = number | "";
type ChannelDrafts = { danggeun: string; albamon: string; sms: string };
type GeneratedContext = {
  prompt: string;
  clientId: number | null;
  branchId: number | null;
  pickupAddress: string;
  dropoffAddress: string;
};

export interface JobCreateStoredDraft {
  prompt: string;
  postingTitle: string;
  channelDrafts: ChannelDrafts | null;
  activeChannel: "danggeun" | "albamon" | "sms";
  aiSource: "ai" | "mock" | null;
  generatedContext: GeneratedContext | null;
  clientId: SelectId;
  branchId: SelectId;
  siteManagerId: SelectId;
  recruitMode: "external" | "internal" | "both";
  capacity: number | "";
  payType: string;
  payAmount: number | "";
  period: string;
  closesAt: string;
  slot: string;
  slotKeys: string[];
  startDate: string;
  pickupAddress: string;
  dropoffAddress: string;
  vehicleRequired: boolean;
  payInfo: string;
  policyNotes: string;
  aiFacts: string;
  extraOpen: boolean;
  exposure: { exposure: "all" | "targeted"; rule: Record<string, unknown> | null };
  duplicatedFrom: string | null;
  channelDraftsFromCopy: boolean;
  sosId: string | null;
  sosRegion: string | null;
  sosVehicle: string | null;
  createAttempt: { fingerprint: string; requestId: string } | null;
}

export interface JobCreateDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type StoredEnvelope = {
  version: 1;
  savedAt: number;
  draft: JobCreateStoredDraft;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function selectId(value: unknown): value is SelectId {
  return value === "" || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function optionalNumber(value: unknown): value is number | "" {
  return value === "" || (typeof value === "number" && Number.isFinite(value));
}

function nullableId(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function channelDrafts(value: unknown): value is ChannelDrafts | null {
  if (value === null) return true;
  const item = record(value);
  return Boolean(
    item
    && typeof item.danggeun === "string"
    && typeof item.albamon === "string"
    && typeof item.sms === "string",
  );
}

function generatedContext(value: unknown): value is GeneratedContext | null {
  if (value === null) return true;
  const item = record(value);
  return Boolean(
    item
    && typeof item.prompt === "string"
    && nullableId(item.clientId)
    && nullableId(item.branchId)
    && typeof item.pickupAddress === "string"
    && typeof item.dropoffAddress === "string",
  );
}

function validDraft(value: unknown): value is JobCreateStoredDraft {
  const draft = record(value);
  if (!draft) return false;

  const stringFields = [
    "prompt",
    "postingTitle",
    "payType",
    "period",
    "closesAt",
    "slot",
    "startDate",
    "pickupAddress",
    "dropoffAddress",
    "payInfo",
    "policyNotes",
    "aiFacts",
  ];
  if (stringFields.some((field) => typeof draft[field] !== "string")) return false;
  if (!channelDrafts(draft.channelDrafts)) return false;
  if (!["danggeun", "albamon", "sms"].includes(String(draft.activeChannel))) return false;
  if (draft.aiSource !== null && draft.aiSource !== "ai" && draft.aiSource !== "mock") return false;
  if (!generatedContext(draft.generatedContext)) return false;
  if (!selectId(draft.clientId) || !selectId(draft.branchId) || !selectId(draft.siteManagerId)) return false;
  if (!["external", "internal", "both"].includes(String(draft.recruitMode))) return false;
  if (!optionalNumber(draft.capacity) || !optionalNumber(draft.payAmount)) return false;
  if (!Array.isArray(draft.slotKeys) || !draft.slotKeys.every((key) => typeof key === "string")) return false;
  if (typeof draft.vehicleRequired !== "boolean" || typeof draft.extraOpen !== "boolean") return false;
  if (draft.duplicatedFrom !== null && typeof draft.duplicatedFrom !== "string") return false;
  if (typeof draft.channelDraftsFromCopy !== "boolean") return false;
  for (const field of ["sosId", "sosRegion", "sosVehicle"] as const) {
    if (draft[field] !== null && typeof draft[field] !== "string") return false;
  }

  if (draft.createAttempt !== null) {
    const attempt = record(draft.createAttempt);
    if (
      !attempt
      || typeof attempt.fingerprint !== "string"
      || typeof attempt.requestId !== "string"
      || !UUID_PATTERN.test(attempt.requestId)
    ) return false;
  }

  const exposure = record(draft.exposure);
  if (!exposure || (exposure.exposure !== "all" && exposure.exposure !== "targeted")) return false;
  if (exposure.rule !== null && !record(exposure.rule)) return false;

  return true;
}

export function encodeJobCreateDraft(draft: JobCreateStoredDraft, now = Date.now()): string {
  const envelope: StoredEnvelope = { version: 1, savedAt: now, draft };
  return JSON.stringify(envelope);
}

export function decodeJobCreateDraft(raw: string | null, now = Date.now()): JobCreateStoredDraft | null {
  if (!raw) return null;

  try {
    const envelope = record(JSON.parse(raw));
    if (
      !envelope
      || envelope.version !== 1
      || typeof envelope.savedAt !== "number"
      || !Number.isFinite(envelope.savedAt)
      || envelope.savedAt > now
      || now - envelope.savedAt > JOB_CREATE_DRAFT_TTL_MS
      || !validDraft(envelope.draft)
    ) {
      return null;
    }
    return envelope.draft;
  } catch {
    return null;
  }
}

export function loadJobCreateDraft(
  storage: JobCreateDraftStorage,
  now = Date.now(),
): JobCreateStoredDraft | null {
  try {
    const raw = storage.getItem(JOB_CREATE_DRAFT_STORAGE_KEY);
    const draft = decodeJobCreateDraft(raw, now);
    if (raw && !draft) storage.removeItem(JOB_CREATE_DRAFT_STORAGE_KEY);
    return draft;
  } catch {
    return null;
  }
}

export function saveJobCreateDraft(
  storage: JobCreateDraftStorage,
  draft: JobCreateStoredDraft,
  now = Date.now(),
): boolean {
  try {
    storage.setItem(JOB_CREATE_DRAFT_STORAGE_KEY, encodeJobCreateDraft(draft, now));
    return true;
  } catch {
    return false;
  }
}

export function removeJobCreateDraft(storage: JobCreateDraftStorage): void {
  try {
    storage.removeItem(JOB_CREATE_DRAFT_STORAGE_KEY);
  } catch {
    // 저장소가 차단된 브라우저에서도 폼 닫기·등록 성공 흐름은 계속한다.
  }
}
