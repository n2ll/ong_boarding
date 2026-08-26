import assert from "node:assert/strict";
import test from "node:test";

const NOW = Date.parse("2026-08-26T09:00:00.000Z");
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
    requestId: "11111111-1111-4111-8111-111111111111",
  },
};

test("a versioned local job draft round-trips within 24 hours", async () => {
  const storageModule = await import("./job-create-draft-storage.ts").catch(() => null);
  const encode = storageModule?.encodeJobCreateDraft;
  const decode = storageModule?.decodeJobCreateDraft;

  assert.equal(typeof encode, "function", "job draft encoder should exist");
  assert.equal(typeof decode, "function", "job draft decoder should exist");
  if (typeof encode !== "function" || typeof decode !== "function") return;

  const raw = encode(draft, NOW);
  assert.deepEqual(decode(raw, NOW + 23 * 60 * 60 * 1000), draft);
});

test("expired, malformed, or incompatible local drafts fail closed", async () => {
  const storageModule = await import("./job-create-draft-storage.ts").catch(() => null);
  const encode = storageModule?.encodeJobCreateDraft;
  const decode = storageModule?.decodeJobCreateDraft;

  assert.equal(typeof encode, "function", "job draft encoder should exist");
  assert.equal(typeof decode, "function", "job draft decoder should exist");
  if (typeof encode !== "function" || typeof decode !== "function") return;

  const raw = encode(draft, NOW);
  assert.equal(decode(raw, NOW + 24 * 60 * 60 * 1000 + 1), null);
  assert.equal(decode("not json", NOW), null);
  assert.equal(decode(JSON.stringify({ version: 999, savedAt: NOW, draft }), NOW), null);
  assert.equal(
    decode(JSON.stringify({ version: 1, savedAt: NOW, draft: { ...draft, capacity: "three" } }), NOW),
    null,
  );
  assert.equal(
    decode(JSON.stringify({
      version: 1,
      savedAt: NOW,
      draft: { ...draft, createAttempt: { ...draft.createAttempt, requestId: "not-a-uuid" } },
    }), NOW),
    null,
  );
});

test("blocked browser storage never breaks the job form", async () => {
  const storageModule = await import("./job-create-draft-storage.ts");
  const storage = {
    getItem(): string | null { throw new Error("blocked"); },
    setItem(): void { throw new Error("blocked"); },
    removeItem(): void { throw new Error("blocked"); },
  };

  assert.equal(storageModule.loadJobCreateDraft(storage, NOW), null);
  assert.equal(storageModule.saveJobCreateDraft(storage, draft, NOW), false);
  assert.doesNotThrow(() => storageModule.removeJobCreateDraft(storage));
});
