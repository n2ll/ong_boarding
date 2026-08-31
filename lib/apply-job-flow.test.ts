import assert from "node:assert/strict";
import test from "node:test";

type ApplyJobIntent =
  | { kind: "general" }
  | { kind: "job"; id: number }
  | { kind: "invalid" };

type ApplicationWorkHourKey = "평일오전" | "평일오후" | "주말오전" | "주말오후";

type ApplyJobFlowModule = {
  applyJobLoadErrorDescription?: (timedOut: boolean) => string;
  applyJobIntent?: (raw: string | null) => ApplyJobIntent;
  classifyApplyJobLookup?: <T>(
    job: T | null,
    error: unknown,
  ) =>
    | { kind: "found"; job: T }
    | { kind: "missing"; status: 404 }
    | { kind: "retryable"; status: 503 };
  shouldShowApplyForm?: (input: {
    intent: ApplyJobIntent;
    loadState: "idle" | "loading" | "loaded" | "unavailable" | "error";
    recruiting: boolean | null;
    generalOptIn: boolean;
  }) => boolean;
  applySubmissionJobContext?: (input: {
    verifiedJobId: number | null;
    recruiting: boolean;
    vehicleRequired: boolean;
    generalOptIn: boolean;
  }) => { jobId: number | null; vehicleRequired: boolean };
  isApplicationBranchContextReady?: (input: {
    intent: ApplyJobIntent;
    generalOptIn: boolean;
    jobLoadState: "idle" | "loading" | "loaded" | "unavailable" | "error";
    jobBranchContextActive: boolean;
    branchLookupRequired: boolean;
    branchListLoadState: "idle" | "loading" | "loaded" | "unavailable" | "error";
  }) => boolean;
  applicationFixedWorkHourKey?: (input: {
    slot: unknown;
    slotKeys: unknown;
  }) => ApplicationWorkHourKey | null;
  applicationFixedWorkHours?: (
    current: string[],
    fixedKey: ApplicationWorkHourKey | null,
  ) => string[];
  applicationFixedWorkHour?: (input: {
    slot: unknown;
    slotKeys: unknown;
  }) => { key: ApplicationWorkHourKey; display: string } | null;
};

async function loadApplyJobFlowModule(): Promise<ApplyJobFlowModule> {
  try {
    const modulePath = "./apply-job-flow.ts";
    return await import(modulePath) as ApplyJobFlowModule;
  } catch {
    return {};
  }
}

test("a malformed job link is not silently treated as a general application", async () => {
  const { applyJobIntent } = await loadApplyJobFlowModule();

  assert.equal(typeof applyJobIntent, "function");
  assert.deepEqual(applyJobIntent!(null), { kind: "general" });
  assert.deepEqual(applyJobIntent!("42"), { kind: "job", id: 42 });
  for (const raw of ["", "0", "-4", "3.5", "abc", "9007199254740993"]) {
    assert.deepEqual(applyJobIntent!(raw), { kind: "invalid" });
  }
});

test("one canonical job slot becomes the applicant form's fixed work hour", async () => {
  const { applicationFixedWorkHourKey } = await loadApplyJobFlowModule();

  assert.equal(typeof applicationFixedWorkHourKey, "function");
  assert.equal(applicationFixedWorkHourKey!({
    slot: "월~금 오전 9시~오후 2시",
    slotKeys: ["평일오전"],
  }), "평일오전");
  assert.equal(applicationFixedWorkHourKey!({
    slot: "주말오후",
    slotKeys: null,
  }), "주말오후");
});

test("ambiguous or custom job schedules keep the applicant's work-hour choices", async () => {
  const { applicationFixedWorkHourKey } = await loadApplyJobFlowModule();

  assert.equal(typeof applicationFixedWorkHourKey, "function");
  assert.equal(applicationFixedWorkHourKey!({
    slot: "평일오전",
    slotKeys: ["평일오전", "평일오후"],
  }), null);
  assert.equal(applicationFixedWorkHourKey!({
    slot: "월~토 오전 7시부터",
    slotKeys: [],
  }), null);
  assert.equal(applicationFixedWorkHourKey!({
    slot: "평일오전",
    slotKeys: ["알수없음"],
  }), null);
});

test("a fixed job slot replaces stale choices and preserves an already-correct answer", async () => {
  const { applicationFixedWorkHours } = await loadApplyJobFlowModule();

  assert.equal(typeof applicationFixedWorkHours, "function");
  assert.deepEqual(
    applicationFixedWorkHours!(["주말(토~일) 오후 타임 (12:00 ~ 17:00)"], "평일오전"),
    ["평일(월~금) 오전 타임 (09:00 ~ 14:00)"],
  );
  const alreadyCorrect = ["평일(월~금) 오전 타임 (09:00 ~ 14:00)"];
  assert.equal(applicationFixedWorkHours!(alreadyCorrect, "평일오전"), alreadyCorrect);
  assert.equal(applicationFixedWorkHours!(alreadyCorrect, null), alreadyCorrect);
});

test("the fixed-hour summary preserves a job's actual schedule without exposing a legacy token", async () => {
  const { applicationFixedWorkHour } = await loadApplyJobFlowModule();

  assert.equal(typeof applicationFixedWorkHour, "function");
  assert.deepEqual(applicationFixedWorkHour!({
    slot: "월~금 오전 7시~낮 12시",
    slotKeys: ["평일오전"],
  }), {
    key: "평일오전",
    display: "월~금 오전 7시~낮 12시",
  });
  assert.deepEqual(applicationFixedWorkHour!({
    slot: "평일오전",
    slotKeys: ["평일오전"],
  }), {
    key: "평일오전",
    display: "평일 오전",
  });
  assert.deepEqual(applicationFixedWorkHour!({
    slot: null,
    slotKeys: ["주말오후"],
  }), {
    key: "주말오후",
    display: "주말 오후",
  });
  assert.equal(applicationFixedWorkHour!({
    slot: "월~토 오전 7시~낮 12시",
    slotKeys: ["평일오전", "주말오전"],
  }), null);
});

test("a job lookup query failure is retryable instead of masquerading as missing", async () => {
  const { classifyApplyJobLookup } = await loadApplyJobFlowModule();

  assert.equal(typeof classifyApplyJobLookup, "function");
  assert.deepEqual(
    classifyApplyJobLookup!(null, { message: "database unavailable" }),
    { kind: "retryable", status: 503 },
  );
});

test("an actual missing job remains not found", async () => {
  const { classifyApplyJobLookup } = await loadApplyJobFlowModule();

  assert.equal(typeof classifyApplyJobLookup, "function");
  assert.deepEqual(classifyApplyJobLookup!(null, null), { kind: "missing", status: 404 });
});

test("a job-linked form stays hidden until an open job is verified", async () => {
  const { shouldShowApplyForm } = await loadApplyJobFlowModule();
  const intent: ApplyJobIntent = { kind: "job", id: 42 };

  assert.equal(typeof shouldShowApplyForm, "function");
  assert.equal(shouldShowApplyForm!({ intent, loadState: "loading", recruiting: null, generalOptIn: false }), false);
  assert.equal(shouldShowApplyForm!({ intent, loadState: "error", recruiting: null, generalOptIn: false }), false);
  assert.equal(shouldShowApplyForm!({ intent, loadState: "unavailable", recruiting: null, generalOptIn: false }), false);
  assert.equal(shouldShowApplyForm!({ intent, loadState: "loaded", recruiting: false, generalOptIn: false }), false);
  assert.equal(shouldShowApplyForm!({ intent, loadState: "loaded", recruiting: true, generalOptIn: false }), true);
});

test("general applications remain available through an explicit fallback choice", async () => {
  const { shouldShowApplyForm } = await loadApplyJobFlowModule();

  assert.equal(typeof shouldShowApplyForm, "function");
  assert.equal(shouldShowApplyForm!({
    intent: { kind: "general" },
    loadState: "idle",
    recruiting: null,
    generalOptIn: false,
  }), true);
  assert.equal(shouldShowApplyForm!({
    intent: { kind: "invalid" },
    loadState: "unavailable",
    recruiting: null,
    generalOptIn: true,
  }), true);
  assert.equal(shouldShowApplyForm!({
    intent: { kind: "job", id: 42 },
    loadState: "loaded",
    recruiting: false,
    generalOptIn: true,
  }), true);
});

test("an explicit general fallback keeps winning if the linked job later becomes available", async () => {
  const { applySubmissionJobContext } = await loadApplyJobFlowModule();

  assert.equal(typeof applySubmissionJobContext, "function");
  assert.deepEqual(applySubmissionJobContext!({
    verifiedJobId: 42,
    recruiting: true,
    vehicleRequired: false,
    generalOptIn: true,
  }), { jobId: null, vehicleRequired: true });
  assert.deepEqual(applySubmissionJobContext!({
    verifiedJobId: 42,
    recruiting: true,
    vehicleRequired: false,
    generalOptIn: false,
  }), { jobId: 42, vehicleRequired: false });
  assert.deepEqual(applySubmissionJobContext!({
    verifiedJobId: 42,
    recruiting: false,
    vehicleRequired: false,
    generalOptIn: false,
  }), { jobId: null, vehicleRequired: true });
});

test("a job lookup failure gives a concrete recovery path without asserting the job is unavailable", async () => {
  const { applyJobLoadErrorDescription } = await loadApplyJobFlowModule();
  assert.equal(typeof applyJobLoadErrorDescription, "function");

  const timeoutCopy = applyJobLoadErrorDescription!(true);
  const retryableCopy = applyJobLoadErrorDescription!(false);
  assert.match(timeoutCopy, /확인 시간이 길어지고 있어요/);
  assert.match(timeoutCopy, /다시 불러오/);
  assert.match(retryableCopy, /다시 불러와/);
  assert.match(retryableCopy, /문자에 답장/);
  assert.doesNotMatch(`${timeoutCopy} ${retryableCopy}`, /마감|바뀐 것은 아니에요/);
});

test("branch answers are not normalized before their server context is ready", async () => {
  const { isApplicationBranchContextReady } = await loadApplyJobFlowModule();
  const jobIntent: ApplyJobIntent = { kind: "job", id: 42 };

  assert.equal(typeof isApplicationBranchContextReady, "function");
  assert.equal(isApplicationBranchContextReady!({
    intent: jobIntent,
    generalOptIn: false,
    jobLoadState: "loading",
    jobBranchContextActive: false,
    branchLookupRequired: false,
    branchListLoadState: "idle",
  }), false);
  assert.equal(isApplicationBranchContextReady!({
    intent: jobIntent,
    generalOptIn: false,
    jobLoadState: "loaded",
    jobBranchContextActive: true,
    branchLookupRequired: false,
    branchListLoadState: "idle",
  }), true);
  assert.equal(isApplicationBranchContextReady!({
    intent: { kind: "general" },
    generalOptIn: false,
    jobLoadState: "idle",
    jobBranchContextActive: false,
    branchLookupRequired: true,
    branchListLoadState: "loading",
  }), false);
  assert.equal(isApplicationBranchContextReady!({
    intent: { kind: "general" },
    generalOptIn: false,
    jobLoadState: "idle",
    jobBranchContextActive: false,
    branchLookupRequired: true,
    branchListLoadState: "loaded",
  }), true);
});
