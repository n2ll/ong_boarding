import assert from "node:assert/strict";
import test from "node:test";

const emptyDraft = () => ({
  prompt: "",
  postingTitle: "",
  channelDrafts: null as { danggeun: string; albamon: string; sms: string } | null,
  clientId: "" as number | "",
  branchId: "" as number | "",
  siteManagerId: "" as number | "",
  recruitModeChanged: false,
  capacity: "" as number | "",
  payType: "",
  payInfo: "",
  period: "",
  closesAt: "",
  slot: "",
  slotKeys: [] as string[],
  startDate: "",
  pickupAddress: "",
  dropoffAddress: "",
  vehicleRequirementChanged: false,
  policyNotes: "",
  aiFacts: "",
  hasCustomExposure: false,
  sosId: null as string | null,
});

test("an untouched or visually opened job form is not an unsaved draft", async () => {
  const draftModule = await import("./job-create-draft.ts").catch(() => null);
  const hasDraft = draftModule?.hasJobCreateDraft;

  assert.equal(typeof hasDraft, "function", "job-create draft detection should exist");
  if (typeof hasDraft !== "function") return;

  assert.equal(hasDraft(emptyDraft()), false);
  assert.equal(
    hasDraft({
      ...emptyDraft(),
      prompt: "  \n ",
      postingTitle: " ",
      channelDrafts: { danggeun: " ", albamon: "\n", sms: "" },
      payInfo: "\t",
      slotKeys: [],
    }),
    false,
    "whitespace and blank direct-write editors should not trigger a destructive confirmation",
  );
});

test("every meaningful visible new-job value is protected from accidental close", async () => {
  const { hasJobCreateDraft } = await import("./job-create-draft.ts");
  const meaningfulChanges: Array<[string, Record<string, unknown>]> = [
    ["AI brief", { prompt: "새벽 배송" }],
    ["posting title", { postingTitle: "성수 배송 기사" }],
    ["channel body", { channelDrafts: { danggeun: "모집합니다", albamon: "", sms: "" } }],
    ["client", { clientId: 11 }],
    ["branch", { branchId: 12 }],
    ["site manager", { siteManagerId: 13 }],
    ["recruit mode", { recruitModeChanged: true }],
    ["capacity", { capacity: 3 }],
    ["pay type", { payType: "건당" }],
    ["pay guidance", { payInfo: "매주 금요일 정산" }],
    ["work period", { period: "단기" }],
    ["closing time", { closesAt: "2026-09-01T18:00" }],
    ["work-hour detail", { slot: "오전 7시~11시" }],
    ["matching slot", { slotKeys: ["평일오전"] }],
    ["start date", { startDate: "2026-09-02" }],
    ["pickup", { pickupAddress: "성수동 물류센터" }],
    ["delivery area", { dropoffAddress: "하남 미사 일대" }],
    ["vehicle requirement", { vehicleRequirementChanged: true }],
    ["policy notes", { policyNotes: "본인 명의 계좌 필요" }],
    ["AI facts", { aiFacts: "주말 로테이션" }],
    ["exposure", { hasCustomExposure: true }],
    ["SOS source", { sosId: "42" }],
  ];

  for (const [label, change] of meaningfulChanges) {
    assert.equal(
      hasJobCreateDraft({ ...emptyDraft(), ...change }),
      true,
      `${label} should be treated as unsaved work`,
    );
  }
});

test("returning toggles to their defaults returns the form to a clean state", async () => {
  const { hasJobCreateDraft } = await import("./job-create-draft.ts");

  assert.equal(
    hasJobCreateDraft({
      ...emptyDraft(),
      recruitModeChanged: false,
      vehicleRequirementChanged: false,
      hasCustomExposure: false,
    }),
    false,
  );

});

test("canonical registration body skips blank channels without losing written copy", async () => {
  const draftModule = await import("./job-create-draft.ts");
  const draftBody = draftModule.jobCreateDraftBody;

  assert.equal(typeof draftBody, "function", "job-create body selection should exist");
  if (typeof draftBody !== "function") return;

  assert.equal(
    draftBody({ danggeun: "당근 본문", albamon: "  \n", sms: "문자 본문" }),
    "당근 본문",
    "a blank preferred channel must not hide a real body in another channel",
  );
  assert.equal(
    draftBody({ danggeun: "당근 본문", albamon: "알바몬 본문", sms: "문자 본문" }),
    "알바몬 본문",
    "the structured Albamon body remains the preferred canonical body",
  );
  assert.equal(draftBody({ danggeun: " ", albamon: "", sms: "\n" }), "");
  assert.equal(draftBody(null), "");
});
