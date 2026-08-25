import assert from "node:assert/strict";
import test from "node:test";

const navigation = await import(
  new URL("./applicant-detail-navigation.ts", import.meta.url).href
) as typeof import("./applicant-detail-navigation");
const { applicantNavigationFocusTarget, createApplicantNavigationFocusCoordinator } = navigation;

test("applicant navigation keeps focus on the requested direction when it remains enabled", () => {
  assert.equal(applicantNavigationFocusTarget("next", true, true), "next");
  assert.equal(applicantNavigationFocusTarget("previous", true, true), "previous");
});

test("applicant navigation falls back to the opposite enabled direction", () => {
  assert.equal(applicantNavigationFocusTarget("next", true, false), "previous");
  assert.equal(applicantNavigationFocusTarget("previous", false, true), "next");
});

test("applicant navigation falls back to the panel title when neither direction is enabled", () => {
  assert.equal(applicantNavigationFocusTarget("next", false, false), "title");
});

test("applicant navigation does not move focus without a navigation request", () => {
  assert.equal(applicantNavigationFocusTarget(null, true, true), null);
  assert.equal(applicantNavigationFocusTarget(null, true, true, true), "title");
});

test("a cancelled navigation clears its focus request", async () => {
  const coordinator = createApplicantNavigationFocusCoordinator();

  await coordinator.request("next", async () => false);

  assert.equal(coordinator.consume(true, true), null);
});

test("a rapid second request cannot overwrite the accepted direction", async () => {
  const coordinator = createApplicantNavigationFocusCoordinator();
  let finishFirst: ((moved: boolean) => void) | null = null;
  const first = coordinator.request("previous", () => new Promise<boolean>((resolve) => {
    finishFirst = resolve;
  }));

  await coordinator.request("next", async () => true);
  assert.equal(typeof finishFirst, "function");
  finishFirst!(true);
  await first;

  assert.equal(coordinator.consume(true, true), "previous");
  assert.equal(coordinator.consume(true, true), null);
});

test("first-result navigation keeps focus on a surviving navigation control", async () => {
  const coordinator = createApplicantNavigationFocusCoordinator();

  await coordinator.request("next", async () => true);

  assert.equal(coordinator.consume(false, true), "next");
});
