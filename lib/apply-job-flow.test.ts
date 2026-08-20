import assert from "node:assert/strict";
import test from "node:test";

type ApplyJobIntent =
  | { kind: "general" }
  | { kind: "job"; id: number }
  | { kind: "invalid" };

type ApplyJobFlowModule = {
  applyJobIntent?: (raw: string | null) => ApplyJobIntent;
  shouldShowApplyForm?: (input: {
    intent: ApplyJobIntent;
    loadState: "idle" | "loading" | "loaded" | "unavailable" | "error";
    recruiting: boolean | null;
    generalOptIn: boolean;
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
  for (const raw of ["", "0", "-4", "3.5", "abc"]) {
    assert.deepEqual(applyJobIntent!(raw), { kind: "invalid" });
  }
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
