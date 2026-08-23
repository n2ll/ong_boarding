import type { ManualMessageAttempt, ManualMessageClientResolution } from "./manual-message-send";

const STORAGE_PREFIX = "ongboarding:manual-message-composer:v1";
const DRAFT_STORAGE_PREFIX = "ongboarding:draft-message-composer:v1";

export interface ManualMessageComposerSnapshot {
  body: string;
  attempt: ManualMessageAttempt | null;
}

export interface ManualMessageComposerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredManualMessageComposerSnapshot extends ManualMessageComposerSnapshot {
  version: 1;
}

function browserSessionStorage(): ManualMessageComposerStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAttempt(value: unknown): value is ManualMessageAttempt {
  return isRecord(value)
    && typeof value.fingerprint === "string"
    && value.fingerprint.length > 0
    && typeof value.key === "string"
    && value.key.length > 0;
}

function parseSnapshot(value: string): ManualMessageComposerSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed)
    || parsed.version !== 1
    || typeof parsed.body !== "string"
    || (parsed.attempt !== null && !isAttempt(parsed.attempt))
  ) {
    return null;
  }
  return {
    body: parsed.body,
    attempt: parsed.attempt === null
      ? null
      : { fingerprint: parsed.attempt.fingerprint, key: parsed.attempt.key },
  };
}

export function manualMessageComposerSnapshotMatches(
  current: ManualMessageComposerSnapshot,
  expected: ManualMessageComposerSnapshot,
): boolean {
  return current.body === expected.body
    && current.attempt?.key === expected.attempt?.key
    && current.attempt?.fingerprint === expected.attempt?.fingerprint;
}

function writeSnapshotAtKey(
  key: string,
  snapshot: ManualMessageComposerSnapshot,
  storage: ManualMessageComposerStorage,
): void {
  const stored: StoredManualMessageComposerSnapshot = {
    version: 1,
    body: snapshot.body,
    attempt: snapshot.attempt,
  };
  storage.setItem(key, JSON.stringify(stored));
}

/** 늦은 응답이 더 새 발송 의도의 저장값을 지우지 않도록 예상 snapshot에만 전이를 적용한다. */
function resolveSnapshotAtKey(
  key: string,
  expected: ManualMessageComposerSnapshot,
  resolution: Pick<ManualMessageClientResolution, "kind" | "clearComposer" | "rotateKey">,
  storage: ManualMessageComposerStorage | null,
): boolean {
  if (!storage || expected.attempt === null) return false;
  try {
    const raw = storage.getItem(key);
    const current = raw === null ? null : parseSnapshot(raw);
    if (!current || !manualMessageComposerSnapshotMatches(current, expected)) return false;
    const transition = manualMessageComposerResolution(expected, resolution);
    if (transition.stored) writeSnapshotAtKey(key, transition.stored, storage);
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function manualMessageComposerStorageKey(
  applicantId: number,
  jobId: number | null
): string {
  return `${STORAGE_PREFIX}:${applicantId}:${jobId ?? "all"}`;
}

export function readManualMessageComposerSnapshot(
  applicantId: number,
  jobId: number | null,
  storage: ManualMessageComposerStorage | null = browserSessionStorage()
): ManualMessageComposerSnapshot | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(manualMessageComposerStorageKey(applicantId, jobId));
    return value === null ? null : parseSnapshot(value);
  } catch {
    return null;
  }
}

export function writeManualMessageComposerSnapshot(
  applicantId: number,
  jobId: number | null,
  snapshot: ManualMessageComposerSnapshot,
  storage: ManualMessageComposerStorage | null = browserSessionStorage()
): boolean {
  if (!storage || typeof snapshot.body !== "string" || (snapshot.attempt !== null && !isAttempt(snapshot.attempt))) {
    return false;
  }
  try {
    writeSnapshotAtKey(manualMessageComposerStorageKey(applicantId, jobId), snapshot, storage);
    return true;
  } catch {
    return false;
  }
}

export function resolveManualMessageComposerSnapshot(
  applicantId: number,
  jobId: number | null,
  expected: ManualMessageComposerSnapshot,
  resolution: Pick<ManualMessageClientResolution, "kind" | "clearComposer" | "rotateKey">,
  storage: ManualMessageComposerStorage | null = browserSessionStorage(),
): boolean {
  return resolveSnapshotAtKey(
    manualMessageComposerStorageKey(applicantId, jobId),
    expected,
    resolution,
    storage,
  );
}

export function clearManualMessageComposerSnapshot(
  applicantId: number,
  jobId: number | null,
  storage: ManualMessageComposerStorage | null = browserSessionStorage()
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(manualMessageComposerStorageKey(applicantId, jobId));
    return true;
  } catch {
    return false;
  }
}

/** API 결과 뒤 화면 표시와 sessionStorage 보존 계약을 한 곳에서 계산한다. */
export function manualMessageComposerResolution(
  snapshot: ManualMessageComposerSnapshot,
  resolution: Pick<ManualMessageClientResolution, "kind" | "clearComposer" | "rotateKey">,
): { stored: ManualMessageComposerSnapshot | null; visible: ManualMessageComposerSnapshot } {
  if (resolution.kind === "sent") {
    return { stored: null, visible: { body: "", attempt: null } };
  }
  const stored = resolution.rotateKey
    ? { body: snapshot.body, attempt: null }
    : snapshot;
  return {
    stored,
    visible: {
      body: resolution.clearComposer ? "" : snapshot.body,
      attempt: stored.attempt,
    },
  };
}

function draftMessageComposerStorageKey(draftId: string): string {
  return `${DRAFT_STORAGE_PREFIX}:${draftId}`;
}

export function readDraftMessageComposerSnapshot(
  draftId: string,
  storage: ManualMessageComposerStorage | null = browserSessionStorage(),
): ManualMessageComposerSnapshot | null {
  if (!storage || !draftId) return null;
  try {
    const value = storage.getItem(draftMessageComposerStorageKey(draftId));
    return value === null ? null : parseSnapshot(value);
  } catch {
    return null;
  }
}

export function writeDraftMessageComposerSnapshot(
  draftId: string,
  snapshot: ManualMessageComposerSnapshot,
  storage: ManualMessageComposerStorage | null = browserSessionStorage(),
): boolean {
  if (!storage || !draftId || typeof snapshot.body !== "string" || (snapshot.attempt !== null && !isAttempt(snapshot.attempt))) {
    return false;
  }
  try {
    writeSnapshotAtKey(draftMessageComposerStorageKey(draftId), snapshot, storage);
    return true;
  } catch {
    return false;
  }
}

export function resolveDraftMessageComposerSnapshot(
  draftId: string,
  expected: ManualMessageComposerSnapshot,
  resolution: Pick<ManualMessageClientResolution, "kind" | "clearComposer" | "rotateKey">,
  storage: ManualMessageComposerStorage | null = browserSessionStorage(),
): boolean {
  if (!draftId) return false;
  return resolveSnapshotAtKey(
    draftMessageComposerStorageKey(draftId),
    expected,
    resolution,
    storage,
  );
}

export function clearDraftMessageComposerSnapshot(
  draftId: string,
  storage: ManualMessageComposerStorage | null = browserSessionStorage(),
): boolean {
  if (!storage || !draftId) return false;
  try {
    storage.removeItem(draftMessageComposerStorageKey(draftId));
    return true;
  } catch {
    return false;
  }
}
