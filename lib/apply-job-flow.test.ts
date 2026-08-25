import assert from "node:assert/strict";
import test from "node:test";

type ApplyJobIntent =
  | { kind: "general" }
  | { kind: "job"; id: number }
  | { kind: "invalid" };

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
