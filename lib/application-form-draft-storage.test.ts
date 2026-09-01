import assert from "node:assert/strict";
import test from "node:test";

import type { ApplicantFormData } from "./applicant-form.ts";
import type { ApplicationSubmissionAttempt } from "./application-submission.ts";

interface ApplicationFormDraftScope {
  source: string;
  job: string | number | null;
  branch: string | null;
  trackingRef?: string | null;
}

interface ApplicationFormDraftSnapshot {
  form: ApplicantFormData;
  generalOptIn: boolean;
  submissionAttempt: ApplicationSubmissionAttempt | null;
  savedAt: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type ApplicationFormDraftStorageModule = {
  applicationFormDraftContentKey?: (
    form: ApplicantFormData,
    generalOptIn: boolean,
    submissionAttempt: ApplicationSubmissionAttempt | null,
  ) => string;
  hasApplicationFormDraftContent?: (
    form: ApplicantFormData,
    generalOptIn: boolean,
    submissionAttempt: ApplicationSubmissionAttempt | null,
    baseline?: ApplicantFormData,
  ) => boolean;
  applicationFormDraftStorageKey?: (scope: ApplicationFormDraftScope) => string;
  readApplicationFormDraftSnapshot?: (
    scope: ApplicationFormDraftScope,
    storage: StorageLike | null,
    now?: number,
  ) => ApplicationFormDraftSnapshot | null;
  writeApplicationFormDraftSnapshot?: (
    scope: ApplicationFormDraftScope,
    snapshot: ApplicationFormDraftSnapshot,
    storage: StorageLike | null,
  ) => boolean;
  removeApplicationFormDraftSnapshot?: (
    scope: ApplicationFormDraftScope,
    storage: StorageLike | null,
  ) => boolean;
  removeApplicationFormDraftSnapshotIfContentKey?: (
    scope: ApplicationFormDraftScope,
    expectedContentKey: string,
    storage: StorageLike | null,
  ) => boolean;
};

async function loadModule(): Promise<ApplicationFormDraftStorageModule> {
  try {
    const modulePath = "./application-form-draft-storage.ts";
    return await import(modulePath) as ApplicationFormDraftStorageModule;
  } catch {
    return {};
  }
}

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  readonly removedKeys: string[] = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removedKeys.push(key);
    this.values.delete(key);
  }
}

const scope: ApplicationFormDraftScope = {
  source: "baemin",
  job: 31,
  branch: "강남점",
};

const form: ApplicantFormData = {
  name: "김지원",
  birthDate: "600101",
  phone: "01012345678",
  location: "서울시 강남구",
  ownVehicle: "있음",
  licenseType: "2종 보통",
  vehicleType: "승용차",
  branch1: "강남점",
  branch2: "서초점",
  workHours: ["평일 오전", "주말 오후"],
  experience: "배송 경험 3년",
  introduction: "안전 운행합니다.",
  availableDate: "2026-09-01",
  selfOwnership: "문제 없음",
  marketingConsent: true,
};

const snapshot: ApplicationFormDraftSnapshot = {
  form,
  generalOptIn: false,
  submissionAttempt: {
    fingerprint: "application-fingerprint",
    id: "41f82761-a37a-4f6f-8ad5-8b6b93acb8c1",
    jobId: 31,
    vehicleRequired: false,
  },
  savedAt: Date.UTC(2026, 7, 25, 3, 0, 0),
};

test("draft scope normalizes source and branch while isolating job context", async () => {
  const { applicationFormDraftStorageKey } = await loadModule();
  assert.equal(typeof applicationFormDraftStorageKey, "function");

  const normalized = applicationFormDraftStorageKey!(scope);
  assert.equal(
    normalized,
    applicationFormDraftStorageKey!({ source: " BAEMIN ", job: "31", branch: "  강남점  " }),
  );
  assert.notEqual(normalized, applicationFormDraftStorageKey!({ ...scope, source: "direct" }));
  assert.notEqual(normalized, applicationFormDraftStorageKey!({ ...scope, job: 32 }));
  assert.notEqual(normalized, applicationFormDraftStorageKey!({ ...scope, branch: "서초점" }));
  assert.notEqual(normalized, applicationFormDraftStorageKey!({ ...scope, branch: null }));
});

test("opaque tracking refs isolate drafts while an untracked URL keeps its existing scope", async () => {
  const { applicationFormDraftStorageKey } = await loadModule();
  assert.equal(typeof applicationFormDraftStorageKey, "function");

  const untracked = applicationFormDraftStorageKey!(scope);
  assert.equal(
    untracked,
    applicationFormDraftStorageKey!({ ...scope, trackingRef: null }),
  );
  assert.equal(
    applicationFormDraftStorageKey!({
      ...scope,
      trackingRef: "91e65ed2-aa20-4f2a-8442-14d11c788ca2",
    }),
    applicationFormDraftStorageKey!({
      ...scope,
      trackingRef: " 91e65ed2-aa20-4f2a-8442-14d11c788ca2 ",
    }),
  );
  assert.notEqual(
    untracked,
    applicationFormDraftStorageKey!({
      ...scope,
      trackingRef: "91e65ed2-aa20-4f2a-8442-14d11c788ca2",
    }),
  );
  assert.notEqual(
    applicationFormDraftStorageKey!({
      ...scope,
      trackingRef: "91e65ed2-aa20-4f2a-8442-14d11c788ca2",
    }),
    applicationFormDraftStorageKey!({
      ...scope,
      trackingRef: "1dfaf018-1f6b-4bc5-b2a8-c600da11cb7e",
    }),
  );
});

test("general applications and invalid job links never share a draft", async () => {
  const { applicationFormDraftStorageKey } = await loadModule();
  assert.equal(typeof applicationFormDraftStorageKey, "function");

  const general = applicationFormDraftStorageKey!({ ...scope, job: null });
  const emptyJobLink = applicationFormDraftStorageKey!({ ...scope, job: "" });
  const invalidJobLink = applicationFormDraftStorageKey!({ ...scope, job: "not-a-job" });
  assert.notEqual(general, emptyJobLink);
  assert.notEqual(general, invalidJobLink);
  assert.notEqual(emptyJobLink, invalidJobLink);
  assert.notEqual(
    applicationFormDraftStorageKey!({ ...scope, job: 31 }),
    applicationFormDraftStorageKey!({ ...scope, job: " 31 " }),
  );
});

test("an untouched form is not retained while any user choice or retry attempt is", async () => {
  const { hasApplicationFormDraftContent } = await loadModule();
  assert.equal(typeof hasApplicationFormDraftContent, "function");
  const emptyForm: ApplicantFormData = {
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
    marketingConsent: null,
  };

  assert.equal(hasApplicationFormDraftContent!(emptyForm, false, null), false);
  assert.equal(hasApplicationFormDraftContent!({ ...emptyForm, name: "김지원" }, false, null), true);
  assert.equal(hasApplicationFormDraftContent!({ ...emptyForm, workHours: ["평일 오전"] }, false, null), true);
  assert.equal(hasApplicationFormDraftContent!({ ...emptyForm, marketingConsent: false }, false, null), true);
  assert.equal(hasApplicationFormDraftContent!({ ...emptyForm, marketingConsent: true }, false, null), true);
  assert.equal(hasApplicationFormDraftContent!(emptyForm, true, null), true);
  assert.equal(hasApplicationFormDraftContent!(emptyForm, false, snapshot.submissionAttempt), true);
  assert.equal(
    hasApplicationFormDraftContent!({ ...emptyForm, branch1: "강남점" }, false, null, { ...emptyForm, branch1: "강남점" }),
    false,
  );
});

test("draft content keys change only when restorable content changes", async () => {
  const { applicationFormDraftContentKey } = await loadModule();
  assert.equal(typeof applicationFormDraftContentKey, "function");

  const original = applicationFormDraftContentKey!(form, false, snapshot.submissionAttempt);
  assert.equal(original, applicationFormDraftContentKey!({ ...form }, false, { ...snapshot.submissionAttempt! }));
  assert.notEqual(original, applicationFormDraftContentKey!({ ...form, name: "다른 이름" }, false, snapshot.submissionAttempt));
  assert.notEqual(original, applicationFormDraftContentKey!(form, true, snapshot.submissionAttempt));
  assert.notEqual(original, applicationFormDraftContentKey!(form, false, null));
  assert.notEqual(original, applicationFormDraftContentKey!(form, false, {
    ...snapshot.submissionAttempt!,
    jobId: null,
  }));
  assert.notEqual(original, applicationFormDraftContentKey!(form, false, {
    ...snapshot.submissionAttempt!,
    vehicleRequired: true,
  }));
});

test("the complete form and submission attempt round-trip in one versioned snapshot", async () => {
  const {
    applicationFormDraftStorageKey,
    readApplicationFormDraftSnapshot,
    writeApplicationFormDraftSnapshot,
  } = await loadModule();
  assert.equal(typeof applicationFormDraftStorageKey, "function");
  assert.equal(typeof readApplicationFormDraftSnapshot, "function");
  assert.equal(typeof writeApplicationFormDraftSnapshot, "function");
  const storage = new MemoryStorage();

  assert.equal(writeApplicationFormDraftSnapshot!(scope, snapshot, storage), true);
  assert.deepEqual(
    readApplicationFormDraftSnapshot!(scope, storage, snapshot.savedAt),
    snapshot,
  );
  assert.deepEqual(
    JSON.parse(storage.values.get(applicationFormDraftStorageKey!(scope)) ?? "null"),
    { version: 2, ...snapshot },
  );
});

test("a v1 draft restores every field but treats its default false consent as unanswered", async () => {
  const { applicationFormDraftStorageKey, readApplicationFormDraftSnapshot } = await loadModule();
  assert.equal(typeof applicationFormDraftStorageKey, "function");
  assert.equal(typeof readApplicationFormDraftSnapshot, "function");
  const storage = new MemoryStorage();
  const key = applicationFormDraftStorageKey!(scope);
  storage.values.set(key, JSON.stringify({
    version: 1,
    ...snapshot,
    form: { ...form, marketingConsent: false },
  }));

  assert.deepEqual(
    readApplicationFormDraftSnapshot!(scope, storage, snapshot.savedAt),
    {
      ...snapshot,
      form: { ...form, marketingConsent: null },
    },
  );
});

test("a v1 draft preserves an affirmative consent choice", async () => {
  const { applicationFormDraftStorageKey, readApplicationFormDraftSnapshot } = await loadModule();
  assert.equal(typeof applicationFormDraftStorageKey, "function");
  assert.equal(typeof readApplicationFormDraftSnapshot, "function");
  const storage = new MemoryStorage();
  storage.values.set(applicationFormDraftStorageKey!(scope), JSON.stringify({
    version: 1,
    ...snapshot,
  }));

  assert.deepEqual(
    readApplicationFormDraftSnapshot!(scope, storage, snapshot.savedAt),
    snapshot,
  );
});

test("malformed, partial, and unknown-version records never restore PII", async () => {
  const { applicationFormDraftStorageKey, readApplicationFormDraftSnapshot } = await loadModule();
  assert.equal(typeof applicationFormDraftStorageKey, "function");
  assert.equal(typeof readApplicationFormDraftSnapshot, "function");
  const storage = new MemoryStorage();
  const key = applicationFormDraftStorageKey!(scope);

  for (const value of [
    "{",
    JSON.stringify({ version: 2, ...snapshot, form: { ...form, phone: 1012345678 } }),
    JSON.stringify({ version: 2, ...snapshot, form: { ...form, workHours: ["평일 오전", 3] } }),
    JSON.stringify({ version: 2, ...snapshot, generalOptIn: "false" }),
    JSON.stringify({ version: 2, ...snapshot, submissionAttempt: { id: snapshot.submissionAttempt!.id } }),
    JSON.stringify({
      version: 2,
      ...snapshot,
      submissionAttempt: {
        fingerprint: "application-fingerprint",
        id: snapshot.submissionAttempt!.id,
      },
    }),
    JSON.stringify({
      version: 2,
      ...snapshot,
      submissionAttempt: { ...snapshot.submissionAttempt, jobId: 0 },
    }),
    JSON.stringify({
      version: 2,
      ...snapshot,
      submissionAttempt: { fingerprint: "application-fingerprint", id: "server-generated" },
    }),
    JSON.stringify({ version: 2, ...snapshot, savedAt: "yesterday" }),
    JSON.stringify({ version: 3, ...snapshot }),
  ]) {
    storage.values.set(key, value);
    assert.equal(readApplicationFormDraftSnapshot!(scope, storage, snapshot.savedAt), null);
  }
});

test("a draft expires after eight hours and its PII is removed", async () => {
  const {
    applicationFormDraftStorageKey,
    readApplicationFormDraftSnapshot,
    writeApplicationFormDraftSnapshot,
  } = await loadModule();
  assert.equal(typeof applicationFormDraftStorageKey, "function");
  assert.equal(typeof readApplicationFormDraftSnapshot, "function");
  assert.equal(typeof writeApplicationFormDraftSnapshot, "function");
  const storage = new MemoryStorage();
  const eightHours = 8 * 60 * 60 * 1_000;

  writeApplicationFormDraftSnapshot!(scope, snapshot, storage);
  assert.deepEqual(
    readApplicationFormDraftSnapshot!(scope, storage, snapshot.savedAt + eightHours),
    snapshot,
  );
  assert.equal(
    readApplicationFormDraftSnapshot!(scope, storage, snapshot.savedAt + eightHours + 1),
    null,
  );
  assert.equal(storage.values.has(applicationFormDraftStorageKey!(scope)), false);
  assert.deepEqual(storage.removedKeys, [applicationFormDraftStorageKey!(scope)]);
});

test("a future-dated record cannot bypass the expiry bound", async () => {
  const {
    readApplicationFormDraftSnapshot,
    writeApplicationFormDraftSnapshot,
  } = await loadModule();
  assert.equal(typeof readApplicationFormDraftSnapshot, "function");
  assert.equal(typeof writeApplicationFormDraftSnapshot, "function");
  const storage = new MemoryStorage();

  writeApplicationFormDraftSnapshot!(scope, snapshot, storage);
  assert.equal(
    readApplicationFormDraftSnapshot!(scope, storage, snapshot.savedAt - 1),
    null,
  );
});

test("removal affects only the requested source, job, and branch scope", async () => {
  const {
    readApplicationFormDraftSnapshot,
    removeApplicationFormDraftSnapshot,
    writeApplicationFormDraftSnapshot,
  } = await loadModule();
  assert.equal(typeof readApplicationFormDraftSnapshot, "function");
  assert.equal(typeof removeApplicationFormDraftSnapshot, "function");
  assert.equal(typeof writeApplicationFormDraftSnapshot, "function");
  const storage = new MemoryStorage();
  const otherScope = { ...scope, job: 32 };

  writeApplicationFormDraftSnapshot!(scope, snapshot, storage);
  writeApplicationFormDraftSnapshot!(otherScope, snapshot, storage);
  assert.equal(removeApplicationFormDraftSnapshot!(scope, storage), true);
  assert.equal(readApplicationFormDraftSnapshot!(scope, storage, snapshot.savedAt), null);
  assert.deepEqual(
    readApplicationFormDraftSnapshot!(otherScope, storage, snapshot.savedAt),
    snapshot,
  );
});

test("a late response cannot clear newer content in the same draft scope", async () => {
  const {
    applicationFormDraftContentKey,
    readApplicationFormDraftSnapshot,
    removeApplicationFormDraftSnapshotIfContentKey,
    writeApplicationFormDraftSnapshot,
  } = await loadModule();
  assert.equal(typeof applicationFormDraftContentKey, "function");
  assert.equal(typeof readApplicationFormDraftSnapshot, "function");
  assert.equal(typeof removeApplicationFormDraftSnapshotIfContentKey, "function");
  assert.equal(typeof writeApplicationFormDraftSnapshot, "function");
  const storage = new MemoryStorage();
  const submittedKey = applicationFormDraftContentKey!(form, false, snapshot.submissionAttempt);
  const newerSnapshot = {
    ...snapshot,
    form: { ...form, introduction: "응답을 기다리며 새로 작성한 내용" },
    savedAt: snapshot.savedAt + 1,
  };
  const newerKey = applicationFormDraftContentKey!(
    newerSnapshot.form,
    newerSnapshot.generalOptIn,
    newerSnapshot.submissionAttempt,
  );

  writeApplicationFormDraftSnapshot!(scope, snapshot, storage);
  writeApplicationFormDraftSnapshot!(scope, newerSnapshot, storage);
  assert.equal(removeApplicationFormDraftSnapshotIfContentKey!(scope, submittedKey, storage), false);
  assert.deepEqual(readApplicationFormDraftSnapshot!(scope, storage, newerSnapshot.savedAt), newerSnapshot);
  assert.equal(removeApplicationFormDraftSnapshotIfContentKey!(scope, newerKey, storage), true);
  assert.equal(readApplicationFormDraftSnapshot!(scope, storage, newerSnapshot.savedAt), null);
});

test("unavailable or throwing storage fails open without breaking the form", async () => {
  const {
    readApplicationFormDraftSnapshot,
    removeApplicationFormDraftSnapshot,
    writeApplicationFormDraftSnapshot,
  } = await loadModule();
  assert.equal(typeof readApplicationFormDraftSnapshot, "function");
  assert.equal(typeof removeApplicationFormDraftSnapshot, "function");
  assert.equal(typeof writeApplicationFormDraftSnapshot, "function");

  assert.equal(readApplicationFormDraftSnapshot!(scope, null, snapshot.savedAt), null);
  assert.equal(writeApplicationFormDraftSnapshot!(scope, snapshot, null), false);
  assert.equal(removeApplicationFormDraftSnapshot!(scope, null), false);

  const throwingStorage: StorageLike = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(readApplicationFormDraftSnapshot!(scope, throwingStorage, snapshot.savedAt), null);
  assert.equal(writeApplicationFormDraftSnapshot!(scope, snapshot, throwingStorage), false);
  assert.equal(removeApplicationFormDraftSnapshot!(scope, throwingStorage), false);
});

test("invalid snapshots are rejected before writing", async () => {
  const { writeApplicationFormDraftSnapshot } = await loadModule();
  assert.equal(typeof writeApplicationFormDraftSnapshot, "function");
  const storage = new MemoryStorage();

  assert.equal(
    writeApplicationFormDraftSnapshot!(
      scope,
      { ...snapshot, savedAt: Number.NaN },
      storage,
    ),
    false,
  );
  assert.equal(storage.values.size, 0);
});
