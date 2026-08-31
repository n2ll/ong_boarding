export const JOB_CREATE_DRAFT_STORAGE_KEY = "ongboarding:job-create-draft:v2";
export const JOB_CREATE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const LEGACY_JOB_CREATE_DRAFT_STORAGE_KEY = "ongboarding:job-create-draft:v1";

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
  version: 2;
  ownerId: string;
  writerId: string;
  generationId: string;
  revision: number;
  savedAt: number;
  draft: JobCreateStoredDraft;
};

export interface JobCreateDraftIdentity {
  ownerId: string;
  writerId: string;
}

export interface JobCreateDraftSnapshot {
  draft: JobCreateStoredDraft;
  generationId: string;
  revision: number;
  writerId: string;
}

export type JobCreateDraftSaveResult =
  | { status: "saved"; generationId: string; revision: number }
  | { status: "conflict"; snapshot: JobCreateDraftSnapshot }
  | { status: "unavailable" };

export type JobCreateDraftDeleteToken = Pick<JobCreateDraftSnapshot, "writerId" | "generationId" | "revision">;

export type JobCreateDraftRemoveResult =
  | { status: "removed" }
  | { status: "missing" }
  | { status: "conflict"; snapshot: JobCreateDraftSnapshot }
  | { status: "unavailable" };

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

export function jobCreateDraftStorageKey(ownerId: string): string {
  return `${JOB_CREATE_DRAFT_STORAGE_KEY}:${ownerId}`;
}

export function removeLegacyJobCreateDraft(storage: JobCreateDraftStorage): void {
  try {
    storage.removeItem(LEGACY_JOB_CREATE_DRAFT_STORAGE_KEY);
  } catch {
    // 이전 ownerless 초안 정리는 best-effort다. 저장소 차단이 공고 작성까지 막아서는 안 된다.
  }
}

export function encodeJobCreateDraft(
  draft: JobCreateStoredDraft,
  identity: JobCreateDraftIdentity,
  revision: number,
  now = Date.now(),
  generationId = globalThis.crypto.randomUUID(),
): string {
  const envelope: StoredEnvelope = {
    version: 2,
    ownerId: identity.ownerId,
    writerId: identity.writerId,
    generationId,
    revision,
    savedAt: now,
    draft,
  };
  return JSON.stringify(envelope);
}

export function decodeJobCreateDraft(
  raw: string | null,
  ownerId: string,
  now = Date.now(),
): JobCreateDraftSnapshot | null {
  if (!raw) return null;

  try {
    const envelope = record(JSON.parse(raw));
    if (
      !envelope
      || envelope.version !== 2
      || envelope.ownerId !== ownerId
      || typeof envelope.writerId !== "string"
      || !UUID_PATTERN.test(envelope.writerId)
      || typeof envelope.generationId !== "string"
      || !UUID_PATTERN.test(envelope.generationId)
      || typeof envelope.revision !== "number"
      || !Number.isSafeInteger(envelope.revision)
      || envelope.revision < 1
      || typeof envelope.savedAt !== "number"
      || !Number.isFinite(envelope.savedAt)
      || envelope.savedAt > now
      || now - envelope.savedAt > JOB_CREATE_DRAFT_TTL_MS
      || !validDraft(envelope.draft)
    ) {
      return null;
    }
    return {
      draft: envelope.draft,
      generationId: envelope.generationId,
      revision: envelope.revision,
      writerId: envelope.writerId,
    };
  } catch {
    return null;
  }
}

export function loadJobCreateDraft(
  storage: JobCreateDraftStorage,
  ownerId: string,
  now = Date.now(),
): JobCreateDraftSnapshot | null {
  if (!UUID_PATTERN.test(ownerId)) return null;
  const key = jobCreateDraftStorageKey(ownerId);
  try {
    const raw = storage.getItem(key);
    const snapshot = decodeJobCreateDraft(raw, ownerId, now);
    if (raw && !snapshot) storage.removeItem(key);
    return snapshot;
  } catch {
    return null;
  }
}

export function saveJobCreateDraft(
  storage: JobCreateDraftStorage,
  draft: JobCreateStoredDraft,
  identity: JobCreateDraftIdentity,
  claimedSnapshot: JobCreateDraftDeleteToken | null,
  now = Date.now(),
  createGenerationId = () => globalThis.crypto.randomUUID(),
): JobCreateDraftSaveResult {
  if (!UUID_PATTERN.test(identity.ownerId) || !UUID_PATTERN.test(identity.writerId)) {
    return { status: "unavailable" };
  }
  const key = jobCreateDraftStorageKey(identity.ownerId);
  try {
    const raw = storage.getItem(key);
    const current = decodeJobCreateDraft(raw, identity.ownerId, now);
    if (raw && !current) storage.removeItem(key);

    if (
      current
      && current.writerId !== identity.writerId
      && (
        claimedSnapshot?.writerId !== current.writerId
        || claimedSnapshot.generationId !== current.generationId
        || claimedSnapshot.revision !== current.revision
      )
    ) {
      return { status: "conflict", snapshot: current };
    }

    const generationId = current?.generationId ?? createGenerationId();
    if (!UUID_PATTERN.test(generationId)) return { status: "unavailable" };
    const revision = (current?.revision ?? 0) + 1;
    storage.setItem(key, encodeJobCreateDraft(draft, identity, revision, now, generationId));
    return { status: "saved", generationId, revision };
  } catch {
    return { status: "unavailable" };
  }
}

export function removeJobCreateDraft(
  storage: JobCreateDraftStorage,
  ownerId: string,
  expected: JobCreateDraftDeleteToken,
  now = Date.now(),
): JobCreateDraftRemoveResult {
  if (
    !UUID_PATTERN.test(ownerId)
    || !UUID_PATTERN.test(expected.writerId)
    || !UUID_PATTERN.test(expected.generationId)
    || !Number.isSafeInteger(expected.revision)
    || expected.revision < 1
  ) return { status: "unavailable" };

  const key = jobCreateDraftStorageKey(ownerId);
  try {
    const raw = storage.getItem(key);
    const current = decodeJobCreateDraft(raw, ownerId, now);
    if (raw && !current) storage.removeItem(key);
    if (!current) return { status: "missing" };
    if (
      current.writerId !== expected.writerId
      || current.generationId !== expected.generationId
      || current.revision !== expected.revision
    ) {
      return { status: "conflict", snapshot: current };
    }

    storage.removeItem(key);
    return { status: "removed" };
  } catch {
    // 저장소가 차단된 브라우저에서도 폼 닫기·등록 성공 흐름은 계속한다.
    return { status: "unavailable" };
  }
}
