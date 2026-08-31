import assert from "node:assert/strict";
import test from "node:test";

const NOW = Date.parse("2026-08-26T09:00:00.000Z");
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WRITER_A = "11111111-1111-4111-8111-111111111111";
const WRITER_B = "22222222-2222-4222-8222-222222222222";
const GENERATION_A = "55555555-5555-4555-8555-555555555555";
const GENERATION_B = "66666666-6666-4666-8666-666666666666";
const GENERATION_C = "77777777-7777-4777-8777-777777777777";

const draft = {
  prompt: "새벽 배송 3명",
  postingTitle: "성수 새벽 배송",
  channelDrafts: { danggeun: "당근 본문", albamon: "알바몬 본문", sms: "문자 본문" },
  activeChannel: "albamon" as const,
  aiSource: "ai" as const,
  generatedContext: {
    prompt: "새벽 배송 3명",
    clientId: 7,
    branchId: 11,
    pickupAddress: "성수 물류센터",
    dropoffAddress: "하남 미사",
  },
  clientId: 7,
  branchId: 11,
  siteManagerId: "" as const,
  recruitMode: "internal" as const,
  capacity: 3,
  payType: "건당",
  payAmount: 3500,
  period: "정기",
  closesAt: "2026-08-30T18:00",
  slot: "오전 3시~9시",
  slotKeys: ["평일오전"],
  startDate: "2026-08-27",
  pickupAddress: "성수 물류센터",
  dropoffAddress: "하남 미사",
  vehicleRequired: true,
  payInfo: "건당 3,500원 · 매주 금요일 정산",
  policyNotes: "본인 명의 계좌 필요",
  aiFacts: "주 5일",
  extraOpen: true,
  exposure: { exposure: "targeted" as const, rule: { sido: ["서울"] } },
  duplicatedFrom: null,
  channelDraftsFromCopy: false,
  sosId: "91",
  sosRegion: "서울 강서구",
  sosVehicle: "1톤 냉장탑차",
  createAttempt: {
    fingerprint: "{\"title\":\"성수 새벽 배송\"}",
    requestId: "33333333-3333-4333-8333-333333333333",
  },
};

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem(key: string): string | null { return items.get(key) ?? null; },
    setItem(key: string, value: string): void { items.set(key, value); },
    removeItem(key: string): void { items.delete(key); },
  };
}

test("legacy ownerless drafts are deleted without touching owner-scoped drafts", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const cleanup = (storageModule as typeof storageModule & {
    removeLegacyJobCreateDraft?: (storage: ReturnType<typeof memoryStorage>) => void;
  }).removeLegacyJobCreateDraft;
  assert.equal(typeof cleanup, "function", "legacy draft cleanup must exist");
  if (!cleanup) return;

  const storage = memoryStorage();
  storage.setItem("ongboarding:job-create-draft:v1", JSON.stringify({
    version: 1,
    savedAt: NOW,
    draft,
  }));
  storageModule.saveJobCreateDraft(
    storage,
    draft,
    { ownerId: OWNER_A, writerId: WRITER_A },
    null,
    NOW,
    () => GENERATION_A,
  );

  cleanup(storage);

  assert.equal(storage.getItem("ongboarding:job-create-draft:v1"), null);
  assert.deepEqual(storageModule.loadJobCreateDraft(storage, OWNER_A, NOW), {
    draft,
    generationId: GENERATION_A,
    revision: 1,
    writerId: WRITER_A,
  });
});

test("an owner-scoped versioned draft round-trips for 24 hours", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const storage = memoryStorage();

  const saved = storageModule.saveJobCreateDraft(
    storage,
    draft,
    { ownerId: OWNER_A, writerId: WRITER_A },
    null,
    NOW,
    () => GENERATION_A,
  );

  assert.deepEqual(saved, { status: "saved", generationId: GENERATION_A, revision: 1 });
  assert.deepEqual(
    storageModule.loadJobCreateDraft(storage, OWNER_A, NOW + 23 * 60 * 60 * 1000),
    { draft, generationId: GENERATION_A, revision: 1, writerId: WRITER_A },
  );
  assert.equal(storageModule.loadJobCreateDraft(storage, OWNER_A, NOW + 24 * 60 * 60 * 1000 + 1), null);
});

test("one signed-in owner never sees or deletes another owner's draft", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const storage = memoryStorage();

  storageModule.saveJobCreateDraft(
    storage,
    draft,
    { ownerId: OWNER_A, writerId: WRITER_A },
    null,
    NOW,
    () => GENERATION_A,
  );

  assert.equal(storageModule.loadJobCreateDraft(storage, OWNER_B, NOW), null);
  assert.deepEqual(
    storageModule.removeJobCreateDraft(
      storage,
      OWNER_B,
      { writerId: WRITER_A, generationId: GENERATION_A, revision: 1 },
      NOW,
    ),
    { status: "missing" },
  );
  assert.deepEqual(storageModule.loadJobCreateDraft(storage, OWNER_A, NOW), {
    draft,
    generationId: GENERATION_A,
    revision: 1,
    writerId: WRITER_A,
  });
});

test("a stale revision cannot delete a newer draft from the same tab", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const storage = memoryStorage();

  storageModule.saveJobCreateDraft(
    storage,
    draft,
    { ownerId: OWNER_A, writerId: WRITER_A },
    null,
    NOW,
    () => GENERATION_A,
  );
  storageModule.saveJobCreateDraft(
    storage,
    { ...draft, postingTitle: "최신 수정본" },
    { ownerId: OWNER_A, writerId: WRITER_A },
    null,
    NOW + 1,
  );

  const removed = storageModule.removeJobCreateDraft(
    storage,
    OWNER_A,
    { writerId: WRITER_A, generationId: GENERATION_A, revision: 1 },
    NOW + 2,
  );

  assert.deepEqual(removed, {
    status: "conflict",
    snapshot: {
      draft: { ...draft, postingTitle: "최신 수정본" },
      generationId: GENERATION_A,
      revision: 2,
      writerId: WRITER_A,
    },
  });
  assert.equal(storageModule.loadJobCreateDraft(storage, OWNER_A, NOW + 2)?.revision, 2);
});

test("a different writer at the same revision cannot be deleted by a stale tab", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const storage = memoryStorage();
  storage.setItem(
    storageModule.jobCreateDraftStorageKey(OWNER_A),
    storageModule.encodeJobCreateDraft(
      draft,
      { ownerId: OWNER_A, writerId: WRITER_B },
      1,
      NOW,
      GENERATION_B,
    ),
  );

  const removed = storageModule.removeJobCreateDraft(
    storage,
    OWNER_A,
    { writerId: WRITER_A, generationId: GENERATION_A, revision: 1 },
    NOW + 1,
  );

  assert.deepEqual(removed, {
    status: "conflict",
    snapshot: { draft, generationId: GENERATION_B, revision: 1, writerId: WRITER_B },
  });
  assert.deepEqual(storageModule.loadJobCreateDraft(storage, OWNER_A, NOW + 1), {
    draft,
    generationId: GENERATION_B,
    revision: 1,
    writerId: WRITER_B,
  });
});

test("an envelope claiming another owner fails closed even under the current owner's key", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const storage = memoryStorage();
  storage.setItem(
    storageModule.jobCreateDraftStorageKey(OWNER_A),
    storageModule.encodeJobCreateDraft(
      draft,
      { ownerId: OWNER_B, writerId: WRITER_B },
      1,
      NOW,
      GENERATION_B,
    ),
  );

  assert.equal(storageModule.loadJobCreateDraft(storage, OWNER_A, NOW), null);
});

test("another tab cannot overwrite a draft until the manager explicitly claims the loaded revision", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const storage = memoryStorage();
  const changedDraft = { ...draft, postingTitle: "하남 새벽 배송" };

  assert.deepEqual(
    storageModule.saveJobCreateDraft(
      storage,
      draft,
      { ownerId: OWNER_A, writerId: WRITER_A },
      null,
      NOW,
      () => GENERATION_A,
    ),
    { status: "saved", generationId: GENERATION_A, revision: 1 },
  );
  assert.deepEqual(
    storageModule.saveJobCreateDraft(
      storage,
      changedDraft,
      { ownerId: OWNER_A, writerId: WRITER_B },
      null,
      NOW + 1,
    ),
    {
      status: "conflict",
      snapshot: { draft, generationId: GENERATION_A, revision: 1, writerId: WRITER_A },
    },
  );

  assert.deepEqual(
    storageModule.saveJobCreateDraft(
      storage,
      changedDraft,
      { ownerId: OWNER_A, writerId: WRITER_B },
      { writerId: WRITER_A, generationId: GENERATION_A, revision: 1 },
      NOW + 2,
    ),
    { status: "saved", generationId: GENERATION_A, revision: 2 },
  );
  assert.deepEqual(storageModule.loadJobCreateDraft(storage, OWNER_A, NOW + 2), {
    draft: changedDraft,
    generationId: GENERATION_A,
    revision: 2,
    writerId: WRITER_B,
  });

  assert.equal(
    storageModule.saveJobCreateDraft(
      storage,
      draft,
      { ownerId: OWNER_A, writerId: WRITER_A },
      null,
      NOW + 3,
    ).status,
    "conflict",
  );
});

test("a stale explicit claim cannot replace edits saved by the other tab", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const storage = memoryStorage();
  const latestDraft = { ...draft, postingTitle: "원래 탭의 최신 수정" };

  storageModule.saveJobCreateDraft(
    storage,
    draft,
    { ownerId: OWNER_A, writerId: WRITER_A },
    null,
    NOW,
    () => GENERATION_A,
  );
  storageModule.saveJobCreateDraft(
    storage,
    latestDraft,
    { ownerId: OWNER_A, writerId: WRITER_A },
    null,
    NOW + 1,
  );

  assert.deepEqual(
    storageModule.saveJobCreateDraft(
      storage,
      { ...draft, postingTitle: "다른 탭의 수정" },
      { ownerId: OWNER_A, writerId: WRITER_B },
      { writerId: WRITER_A, generationId: GENERATION_A, revision: 1 },
      NOW + 2,
    ),
    {
      status: "conflict",
      snapshot: { draft: latestDraft, generationId: GENERATION_A, revision: 2, writerId: WRITER_A },
    },
  );
});

test("an ABA replacement with the same revision but a different writer rejects a stale claim", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const storage = memoryStorage();
  const replacementDraft = { ...draft, postingTitle: "새 탭이 다시 만든 초안" };
  storage.setItem(
    storageModule.jobCreateDraftStorageKey(OWNER_A),
    storageModule.encodeJobCreateDraft(
      replacementDraft,
      { ownerId: OWNER_A, writerId: WRITER_B },
      1,
      NOW,
      GENERATION_B,
    ),
  );

  assert.deepEqual(
    storageModule.saveJobCreateDraft(
      storage,
      { ...draft, postingTitle: "삭제 전 초안을 이어 쓴 내용" },
      { ownerId: OWNER_A, writerId: "44444444-4444-4444-8444-444444444444" },
      { writerId: WRITER_A, generationId: GENERATION_A, revision: 1 },
      NOW + 1,
    ),
    {
      status: "conflict",
      snapshot: { draft: replacementDraft, generationId: GENERATION_B, revision: 1, writerId: WRITER_B },
    },
  );
  assert.deepEqual(storageModule.loadJobCreateDraft(storage, OWNER_A, NOW + 1), {
    draft: replacementDraft,
    generationId: GENERATION_B,
    revision: 1,
    writerId: WRITER_B,
  });
});

test("a same-writer replacement generation rejects a stale claim from the deleted draft", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const storage = memoryStorage();

  storageModule.saveJobCreateDraft(
    storage,
    draft,
    { ownerId: OWNER_A, writerId: WRITER_A },
    null,
    NOW,
    () => GENERATION_A,
  );
  const staleClaim = storageModule.loadJobCreateDraft(storage, OWNER_A, NOW);
  assert.ok(staleClaim);
  assert.deepEqual(
    storageModule.removeJobCreateDraft(storage, OWNER_A, staleClaim, NOW + 1),
    { status: "removed" },
  );

  const replacementDraft = { ...draft, postingTitle: "같은 탭이 새로 만든 초안" };
  storageModule.saveJobCreateDraft(
    storage,
    replacementDraft,
    { ownerId: OWNER_A, writerId: WRITER_A },
    null,
    NOW + 2,
    () => GENERATION_C,
  );
  const replacementSnapshot = storageModule.loadJobCreateDraft(storage, OWNER_A, NOW + 2);
  assert.ok(replacementSnapshot);

  assert.deepEqual(
    storageModule.saveJobCreateDraft(
      storage,
      { ...draft, postingTitle: "삭제된 초안을 이어 쓴 내용" },
      { ownerId: OWNER_A, writerId: "44444444-4444-4444-8444-444444444444" },
      staleClaim,
      NOW + 3,
    ),
    {
      status: "conflict",
      snapshot: replacementSnapshot,
    },
  );
  assert.equal(
    storageModule.loadJobCreateDraft(storage, OWNER_A, NOW + 3)?.draft.postingTitle,
    replacementDraft.postingTitle,
  );
});

test("malformed, ownerless legacy, or incompatible local drafts fail closed", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const storage = memoryStorage();
  const key = storageModule.jobCreateDraftStorageKey(OWNER_A);

  storage.setItem(key, "not json");
  assert.equal(storageModule.loadJobCreateDraft(storage, OWNER_A, NOW), null);

  storage.setItem(key, JSON.stringify({ version: 1, savedAt: NOW, draft }));
  assert.equal(storageModule.loadJobCreateDraft(storage, OWNER_A, NOW), null);

  storage.setItem(key, JSON.stringify({
    version: 2,
    ownerId: OWNER_A,
    writerId: WRITER_A,
    generationId: GENERATION_A,
    revision: 1,
    savedAt: NOW,
    draft: { ...draft, capacity: "three" },
  }));
  assert.equal(storageModule.loadJobCreateDraft(storage, OWNER_A, NOW), null);

  storage.setItem(key, JSON.stringify({
    version: 2,
    ownerId: OWNER_A,
    writerId: WRITER_A,
    generationId: GENERATION_A,
    revision: 1,
    savedAt: NOW,
    draft: { ...draft, createAttempt: { ...draft.createAttempt, requestId: "not-a-uuid" } },
  }));
  assert.equal(storageModule.loadJobCreateDraft(storage, OWNER_A, NOW), null);
});

test("an unknown owner or blocked browser storage never breaks the job form", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const storage = {
    getItem(): string | null { throw new Error("blocked"); },
    setItem(): void { throw new Error("blocked"); },
    removeItem(): void { throw new Error("blocked"); },
  };

  assert.equal(storageModule.loadJobCreateDraft(storage, "", NOW), null);
  assert.deepEqual(
    storageModule.saveJobCreateDraft(
      storage,
      draft,
      { ownerId: "", writerId: WRITER_A },
      null,
      NOW,
    ),
    { status: "unavailable" },
  );
  assert.deepEqual(
    storageModule.removeJobCreateDraft(
      storage,
      OWNER_A,
      { writerId: WRITER_A, generationId: GENERATION_A, revision: 1 },
      NOW,
    ),
    { status: "unavailable" },
  );
});
