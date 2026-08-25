import assert from "node:assert/strict";
import test from "node:test";

type TransitionOutcome = "proceeded" | "cancelled" | "deferred" | "ignored";
type TransitionRequest = {
  kind: "manual" | "automatic";
  dirty: boolean;
  confirmDiscard: () => Promise<boolean>;
  transition: () => void | Promise<void>;
};
type TransitionCoordinator = {
  run: (request: TransitionRequest) => Promise<TransitionOutcome>;
};
type DraftFieldKind = "text" | "nullable-boolean" | "exact";

type ApplicantDetailUnsavedModule = {
  createApplicantDetailTransitionCoordinator?: () => TransitionCoordinator;
  applicantDetailDraftValuesEqual?: (
    originalValue: unknown,
    nextValue: unknown,
    kind: DraftFieldKind,
  ) => boolean;
  updateApplicantDetailDraft?: (
    draft: Record<string, unknown>,
    field: string,
    originalValue: unknown,
    nextValue: unknown,
    kind: DraftFieldKind,
  ) => Record<string, unknown>;
};

async function loadModule(): Promise<ApplicantDetailUnsavedModule> {
  try {
    return await import(new URL("./applicant-detail-unsaved.ts", import.meta.url).href) as ApplicantDetailUnsavedModule;
  } catch {
    return {};
  }
}

async function loadCoordinator(): Promise<TransitionCoordinator> {
  const { createApplicantDetailTransitionCoordinator } = await loadModule();
  assert.equal(typeof createApplicantDetailTransitionCoordinator, "function");
  return createApplicantDetailTransitionCoordinator!();
}

test("a clean manual transition proceeds without asking to discard", async () => {
  const coordinator = await loadCoordinator();
  let confirmations = 0;
  let transitions = 0;

  const outcome = await coordinator.run({
    kind: "manual",
    dirty: false,
    confirmDiscard: async () => {
      confirmations += 1;
      return true;
    },
    transition: () => {
      transitions += 1;
    },
  });

  assert.equal(outcome, "proceeded");
  assert.equal(confirmations, 0);
  assert.equal(transitions, 1);
});

test("cancelling a dirty manual transition preserves the draft and stays put", async () => {
  const coordinator = await loadCoordinator();
  let confirmations = 0;
  let transitions = 0;

  const outcome = await coordinator.run({
    kind: "manual",
    dirty: true,
    confirmDiscard: async () => {
      confirmations += 1;
      return false;
    },
    transition: () => {
      transitions += 1;
    },
  });

  assert.equal(outcome, "cancelled");
  assert.equal(confirmations, 1);
  assert.equal(transitions, 0);
});

test("confirming a dirty manual transition runs the requested transition once", async () => {
  const coordinator = await loadCoordinator();
  let confirmations = 0;
  let transitions = 0;

  const outcome = await coordinator.run({
    kind: "manual",
    dirty: true,
    confirmDiscard: async () => {
      confirmations += 1;
      return true;
    },
    transition: () => {
      transitions += 1;
    },
  });

  assert.equal(outcome, "proceeded");
  assert.equal(confirmations, 1);
  assert.equal(transitions, 1);
});

test("a dirty automatic transition is deferred without prompting or moving", async () => {
  const coordinator = await loadCoordinator();
  let confirmations = 0;
  let transitions = 0;

  const outcome = await coordinator.run({
    kind: "automatic",
    dirty: true,
    confirmDiscard: async () => {
      confirmations += 1;
      return true;
    },
    transition: () => {
      transitions += 1;
    },
  });

  assert.equal(outcome, "deferred");
  assert.equal(confirmations, 0);
  assert.equal(transitions, 0);
});

test("a second rapid manual request is ignored while the first confirmation is pending", async () => {
  const coordinator = await loadCoordinator();
  let resolveFirstConfirmation: ((confirmed: boolean) => void) | undefined;
  let confirmations = 0;
  const transitions: string[] = [];

  const first = coordinator.run({
    kind: "manual",
    dirty: true,
    confirmDiscard: () => {
      confirmations += 1;
      return new Promise<boolean>((resolve) => {
        resolveFirstConfirmation = resolve;
      });
    },
    transition: () => {
      transitions.push("first");
    },
  });
  const second = coordinator.run({
    kind: "manual",
    dirty: true,
    confirmDiscard: async () => {
      confirmations += 1;
      return true;
    },
    transition: () => {
      transitions.push("second");
    },
  });

  assert.equal(await second, "ignored");
  assert.equal(confirmations, 1);
  assert.deepEqual(transitions, []);

  assert.equal(typeof resolveFirstConfirmation, "function");
  resolveFirstConfirmation!(true);
  assert.equal(await first, "proceeded");
  assert.deepEqual(transitions, ["first"]);
});

test("draft equality follows what nullable text and checkbox controls render", async () => {
  const { applicantDetailDraftValuesEqual } = await loadModule();
  assert.equal(typeof applicantDetailDraftValuesEqual, "function");

  assert.equal(applicantDetailDraftValuesEqual!(null, "", "text"), true);
  assert.equal(applicantDetailDraftValuesEqual!("", null, "text"), true);
  assert.equal(applicantDetailDraftValuesEqual!(null, false, "nullable-boolean"), true);
  assert.equal(applicantDetailDraftValuesEqual!(false, null, "nullable-boolean"), true);
  assert.equal(applicantDetailDraftValuesEqual!(null, true, "nullable-boolean"), false);
  assert.equal(applicantDetailDraftValuesEqual!("강남", "", "text"), false);
  assert.equal(applicantDetailDraftValuesEqual!(0, false, "exact"), false);
});

test("returning a text field to its rendered original value removes it from the draft", async () => {
  const { updateApplicantDetailDraft } = await loadModule();
  assert.equal(typeof updateApplicantDetailDraft, "function");

  const changed = updateApplicantDetailDraft!({}, "confirmed_branch", null, "강남", "text");
  assert.deepEqual(changed, { confirmed_branch: "강남" });

  const reverted = updateApplicantDetailDraft!(changed, "confirmed_branch", null, "", "text");
  assert.deepEqual(reverted, {});
  assert.deepEqual(changed, { confirmed_branch: "강남" }, "draft updates must not mutate prior state");
});

test("an unchecked nullable checkbox does not create or retain a false draft", async () => {
  const { updateApplicantDetailDraft } = await loadModule();
  assert.equal(typeof updateApplicantDetailDraft, "function");

  assert.deepEqual(
    updateApplicantDetailDraft!({}, "guide_sent", null, false, "nullable-boolean"),
    {},
  );

  const checked = updateApplicantDetailDraft!({}, "guide_sent", null, true, "nullable-boolean");
  assert.deepEqual(checked, { guide_sent: true });
  assert.deepEqual(
    updateApplicantDetailDraft!(checked, "guide_sent", null, false, "nullable-boolean"),
    {},
  );
});
