import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface Attempt {
  fingerprint: string;
  key: string;
}

interface Snapshot {
  body: string;
  attempt: Attempt | null;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type ComposerStorageModule = {
  manualMessageComposerStorageKey?: (applicantId: number, jobId: number | null) => string;
  readManualMessageComposerSnapshot?: (
    applicantId: number,
    jobId: number | null,
    storage?: StorageLike | null
  ) => Snapshot | null;
  writeManualMessageComposerSnapshot?: (
    applicantId: number,
    jobId: number | null,
    snapshot: Snapshot,
    storage?: StorageLike | null
  ) => boolean;
  clearManualMessageComposerSnapshot?: (
    applicantId: number,
    jobId: number | null,
    storage?: StorageLike | null
  ) => boolean;
  manualMessageComposerResolution?: (
    snapshot: Snapshot,
    resolution: { kind: "sent" | "sent_unrecorded" | "sent_followup_failed" | "unknown" | "failed" | "not_attempted"; clearComposer: boolean; rotateKey: boolean },
  ) => { stored: Snapshot | null; visible: Snapshot };
  manualMessageComposerSnapshotMatches?: (current: Snapshot, expected: Snapshot) => boolean;
  resolveManualMessageComposerSnapshot?: (
    applicantId: number,
    jobId: number | null,
    expected: Snapshot,
    resolution: { kind: "sent" | "sent_unrecorded" | "sent_followup_failed" | "unknown" | "failed" | "not_attempted"; clearComposer: boolean; rotateKey: boolean },
    storage?: StorageLike | null,
  ) => boolean;
  readDraftMessageComposerSnapshot?: (draftId: string, storage?: StorageLike | null) => Snapshot | null;
  writeDraftMessageComposerSnapshot?: (draftId: string, snapshot: Snapshot, storage?: StorageLike | null) => boolean;
  resolveDraftMessageComposerSnapshot?: (
    draftId: string,
    expected: Snapshot,
    resolution: { kind: "sent" | "sent_unrecorded" | "sent_followup_failed" | "unknown" | "failed" | "not_attempted"; clearComposer: boolean; rotateKey: boolean },
    storage?: StorageLike | null,
  ) => boolean;
  clearDraftMessageComposerSnapshot?: (draftId: string, storage?: StorageLike | null) => boolean;
};

async function loadModule(): Promise<ComposerStorageModule> {
  try {
    return await import(new URL("./manual-message-composer-storage.ts", import.meta.url).href) as ComposerStorageModule;
  } catch {
    return {};
  }
}

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  setCalls = 0;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.setCalls += 1;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const snapshot: Snapshot = {
  body: "안녕하세요. 확인 후 안내드릴게요.",
  attempt: {
    fingerprint: '[17,"01012345678","안녕하세요. 확인 후 안내드릴게요.",31,"관리자",null,false]',
    key: "41f82761-a37a-4f6f-8ad5-8b6b93acb8c1",
  },
};

test("manual composer storage is isolated by both applicant and job", async () => {
  const { manualMessageComposerStorageKey } = await loadModule();
  assert.equal(typeof manualMessageComposerStorageKey, "function");

  const applicantJob = manualMessageComposerStorageKey!(17, 31);
  assert.notEqual(applicantJob, manualMessageComposerStorageKey!(18, 31));
  assert.notEqual(applicantJob, manualMessageComposerStorageKey!(17, 32));
  assert.notEqual(applicantJob, manualMessageComposerStorageKey!(17, null));
});

test("body and idempotency attempt round-trip in one storage write", async () => {
  const { writeManualMessageComposerSnapshot, readManualMessageComposerSnapshot } = await loadModule();
  assert.equal(typeof writeManualMessageComposerSnapshot, "function");
  assert.equal(typeof readManualMessageComposerSnapshot, "function");
  const storage = new MemoryStorage();

  assert.equal(writeManualMessageComposerSnapshot!(17, 31, snapshot, storage), true);
  assert.equal(storage.setCalls, 1);
  assert.deepEqual(readManualMessageComposerSnapshot!(17, 31, storage), snapshot);
  assert.equal(readManualMessageComposerSnapshot!(17, 32, storage), null);
});

test("a malformed record never restores only half of a send intent", async () => {
  const { manualMessageComposerStorageKey, readManualMessageComposerSnapshot } = await loadModule();
  assert.equal(typeof manualMessageComposerStorageKey, "function");
  assert.equal(typeof readManualMessageComposerSnapshot, "function");
  const storage = new MemoryStorage();
  const key = manualMessageComposerStorageKey!(17, 31);

  for (const value of [
    "{",
    JSON.stringify({ version: 1, body: snapshot.body }),
    JSON.stringify({ version: 1, body: snapshot.body, attempt: { fingerprint: "", key: snapshot.attempt!.key } }),
    JSON.stringify({ version: 2, body: snapshot.body, attempt: snapshot.attempt }),
  ]) {
    storage.values.set(key, value);
    assert.equal(readManualMessageComposerSnapshot!(17, 31, storage), null);
  }
});

test("clearing a completed send removes only that applicant and job snapshot", async () => {
  const {
    writeManualMessageComposerSnapshot,
    readManualMessageComposerSnapshot,
    clearManualMessageComposerSnapshot,
  } = await loadModule();
  assert.equal(typeof writeManualMessageComposerSnapshot, "function");
  assert.equal(typeof readManualMessageComposerSnapshot, "function");
  assert.equal(typeof clearManualMessageComposerSnapshot, "function");
  const storage = new MemoryStorage();
  writeManualMessageComposerSnapshot!(17, 31, snapshot, storage);
  writeManualMessageComposerSnapshot!(17, 32, { body: "다른 공고", attempt: null }, storage);

  assert.equal(clearManualMessageComposerSnapshot!(17, 31, storage), true);
  assert.equal(readManualMessageComposerSnapshot!(17, 31, storage), null);
  assert.deepEqual(
    readManualMessageComposerSnapshot!(17, 32, storage),
    { body: "다른 공고", attempt: null }
  );
});

test("SSR and unavailable browser storage fail closed without throwing", async () => {
  const {
    readManualMessageComposerSnapshot,
    writeManualMessageComposerSnapshot,
    clearManualMessageComposerSnapshot,
  } = await loadModule();
  assert.equal(typeof readManualMessageComposerSnapshot, "function");
  assert.equal(typeof writeManualMessageComposerSnapshot, "function");
  assert.equal(typeof clearManualMessageComposerSnapshot, "function");

  assert.equal(readManualMessageComposerSnapshot!(17, 31, null), null);
  assert.equal(writeManualMessageComposerSnapshot!(17, 31, snapshot, null), false);
  assert.equal(clearManualMessageComposerSnapshot!(17, 31, null), false);

  const throwingStorage: StorageLike = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(readManualMessageComposerSnapshot!(17, 31, throwingStorage), null);
  assert.equal(writeManualMessageComposerSnapshot!(17, 31, snapshot, throwingStorage), false);
  assert.equal(clearManualMessageComposerSnapshot!(17, 31, throwingStorage), false);

  assert.equal(readManualMessageComposerSnapshot!(17, 31), null);
  assert.equal(writeManualMessageComposerSnapshot!(17, 31, snapshot), false);
  assert.equal(clearManualMessageComposerSnapshot!(17, 31), false);
});

test("composer resolution preserves the original attempt unless the send is fully settled", async () => {
  const { manualMessageComposerResolution } = await loadModule();
  assert.equal(typeof manualMessageComposerResolution, "function");

  assert.deepEqual(
    manualMessageComposerResolution!(snapshot, { kind: "sent", clearComposer: true, rotateKey: true }),
    { stored: null, visible: { body: "", attempt: null } },
  );
  for (const kind of ["sent_unrecorded", "sent_followup_failed", "unknown"] as const) {
    assert.deepEqual(
      manualMessageComposerResolution!(snapshot, { kind, clearComposer: true, rotateKey: false }),
      { stored: snapshot, visible: { body: "", attempt: snapshot.attempt } },
    );
  }
  assert.deepEqual(
    manualMessageComposerResolution!(snapshot, { kind: "failed", clearComposer: false, rotateKey: true }),
    { stored: { body: snapshot.body, attempt: null }, visible: { body: snapshot.body, attempt: null } },
  );
  assert.deepEqual(
    manualMessageComposerResolution!(snapshot, { kind: "not_attempted", clearComposer: false, rotateKey: false }),
    { stored: snapshot, visible: snapshot },
  );
});

test("edited AI draft text and its send attempt are isolated by draft id", async () => {
  const {
    readDraftMessageComposerSnapshot,
    writeDraftMessageComposerSnapshot,
    clearDraftMessageComposerSnapshot,
  } = await loadModule();
  assert.equal(typeof readDraftMessageComposerSnapshot, "function");
  assert.equal(typeof writeDraftMessageComposerSnapshot, "function");
  assert.equal(typeof clearDraftMessageComposerSnapshot, "function");
  const storage = new MemoryStorage();

  assert.equal(writeDraftMessageComposerSnapshot!("draft-a", snapshot, storage), true);
  assert.equal(writeDraftMessageComposerSnapshot!("draft-b", { body: "B 초안", attempt: null }, storage), true);
  assert.deepEqual(readDraftMessageComposerSnapshot!("draft-a", storage), snapshot);
  assert.deepEqual(readDraftMessageComposerSnapshot!("draft-b", storage), { body: "B 초안", attempt: null });
  assert.equal(clearDraftMessageComposerSnapshot!("draft-a", storage), true);
  assert.equal(readDraftMessageComposerSnapshot!("draft-a", storage), null);
  assert.deepEqual(readDraftMessageComposerSnapshot!("draft-b", storage), { body: "B 초안", attempt: null });
});

test("a late response cannot overwrite a newer manual send snapshot", async () => {
  const {
    writeManualMessageComposerSnapshot,
    readManualMessageComposerSnapshot,
    resolveManualMessageComposerSnapshot,
  } = await loadModule();
  assert.equal(typeof writeManualMessageComposerSnapshot, "function");
  assert.equal(typeof readManualMessageComposerSnapshot, "function");
  assert.equal(typeof resolveManualMessageComposerSnapshot, "function");
  const storage = new MemoryStorage();
  const newer = {
    body: "새 발송 문구",
    attempt: {
      fingerprint: '[17,"01012345678","새 발송 문구",31,"관리자",null,false]',
      key: "b5a9ae89-b79d-4a07-9db6-a49f58446f88",
    },
  };
  writeManualMessageComposerSnapshot!(17, 31, snapshot, storage);
  writeManualMessageComposerSnapshot!(17, 31, newer, storage);

  assert.equal(
    resolveManualMessageComposerSnapshot!(
      17,
      31,
      snapshot,
      { kind: "sent", clearComposer: true, rotateKey: true },
      storage,
    ),
    false,
  );
  assert.deepEqual(readManualMessageComposerSnapshot!(17, 31, storage), newer);
});

test("a late response also preserves edited body under the same attempt key", async () => {
  const {
    writeManualMessageComposerSnapshot,
    readManualMessageComposerSnapshot,
    resolveManualMessageComposerSnapshot,
    manualMessageComposerSnapshotMatches,
  } = await loadModule();
  assert.equal(typeof resolveManualMessageComposerSnapshot, "function");
  assert.equal(typeof manualMessageComposerSnapshotMatches, "function");
  const storage = new MemoryStorage();
  const edited = { ...snapshot, body: `${snapshot.body} 수정` };
  writeManualMessageComposerSnapshot!(17, 31, edited, storage);

  assert.equal(manualMessageComposerSnapshotMatches!(edited, snapshot), false);
  assert.equal(
    resolveManualMessageComposerSnapshot!(
      17,
      31,
      snapshot,
      { kind: "sent", clearComposer: true, rotateKey: true },
      storage,
    ),
    false,
  );
  assert.deepEqual(readManualMessageComposerSnapshot!(17, 31, storage), edited);
});

test("the matching response transitions manual and draft storage exactly once", async () => {
  const {
    writeManualMessageComposerSnapshot,
    readManualMessageComposerSnapshot,
    resolveManualMessageComposerSnapshot,
    writeDraftMessageComposerSnapshot,
    readDraftMessageComposerSnapshot,
    resolveDraftMessageComposerSnapshot,
  } = await loadModule();
  assert.equal(typeof resolveManualMessageComposerSnapshot, "function");
  assert.equal(typeof resolveDraftMessageComposerSnapshot, "function");
  const storage = new MemoryStorage();
  writeManualMessageComposerSnapshot!(17, 31, snapshot, storage);
  writeDraftMessageComposerSnapshot!("draft-a", snapshot, storage);

  const sent = { kind: "sent" as const, clearComposer: true, rotateKey: true };
  assert.equal(resolveManualMessageComposerSnapshot!(17, 31, snapshot, sent, storage), true);
  assert.equal(readManualMessageComposerSnapshot!(17, 31, storage), null);
  assert.equal(resolveManualMessageComposerSnapshot!(17, 31, snapshot, sent, storage), false);
  assert.equal(resolveDraftMessageComposerSnapshot!("draft-a", snapshot, sent, storage), true);
  assert.equal(readDraftMessageComposerSnapshot!("draft-a", storage), null);
  assert.equal(resolveDraftMessageComposerSnapshot!("draft-a", snapshot, sent, storage), false);
});

test("storage transition failure is reported without mutating the expected snapshot", async () => {
  const { resolveManualMessageComposerSnapshot } = await loadModule();
  assert.equal(typeof resolveManualMessageComposerSnapshot, "function");
  const throwingStorage: StorageLike = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };

  assert.equal(
    resolveManualMessageComposerSnapshot!(
      17,
      31,
      snapshot,
      { kind: "sent", clearComposer: true, rotateKey: true },
      throwingStorage,
    ),
    false,
  );
});

test("manual composer resolution keeps storage identity separate from thread scope identity", async () => {
  const thread = await readFile(
    new URL("../components/ConversationThread.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    thread,
    /const applyManualComposerResolution[\s\S]*?origin:\s*\{[\s\S]*?scopeKey:\s*string;[\s\S]*?scopeRevision:\s*number;[\s\S]*?composerKey:\s*string;[\s\S]*?if\s*\(\s*!isCurrentThreadScope\(origin\.scopeKey,\s*origin\.scopeRevision\)\s*\)\s*return;[\s\S]*?previous\.scopeKey\s*===\s*origin\.composerKey[\s\S]*?scopeKey:\s*origin\.composerKey/,
  );
});
