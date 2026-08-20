import assert from "node:assert/strict";
import test from "node:test";

type AvailabilityDecision =
  | { nextAvailability: "즉시가능" }
  | null;

async function loadAvailabilityModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./pool-availability.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("ordinary interest never promotes global availability", async () => {
  const availabilityModule = await loadAvailabilityModule();
  const poolAvailabilityDecision = availabilityModule.poolAvailabilityDecision as
    ((current: string | null, action: "interest" | "notify" | "immediate") => AvailabilityDecision) | undefined;

  assert.equal(typeof poolAvailabilityDecision, "function");
  assert.equal(poolAvailabilityDecision!("미확인", "interest"), null);
  assert.equal(poolAvailabilityDecision!("이번주가능", "interest"), null);
});

test("next-opportunity notification never promotes global availability", async () => {
  const availabilityModule = await loadAvailabilityModule();
  const poolAvailabilityDecision = availabilityModule.poolAvailabilityDecision as
    ((current: string | null, action: "interest" | "notify" | "immediate") => AvailabilityDecision) | undefined;

  assert.equal(typeof poolAvailabilityDecision, "function");
  assert.equal(poolAvailabilityDecision!(null, "notify"), null);
  assert.equal(poolAvailabilityDecision!("미확인", "notify"), null);
});

test("only an explicit today-or-tomorrow answer promotes immediate availability", async () => {
  const availabilityModule = await loadAvailabilityModule();
  const poolAvailabilityDecision = availabilityModule.poolAvailabilityDecision as
    ((current: string | null, action: "interest" | "notify" | "immediate") => AvailabilityDecision) | undefined;

  assert.equal(typeof poolAvailabilityDecision, "function");
  assert.deepEqual(poolAvailabilityDecision!("미확인", "immediate"), {
    nextAvailability: "즉시가능",
  });
  assert.equal(poolAvailabilityDecision!("즉시가능", "immediate"), null);
});

test("immediate action copy asks about today or tomorrow, not the job start date", async () => {
  const availabilityModule = await loadAvailabilityModule();
  const IMMEDIATE_AVAILABILITY_COPY = availabilityModule.IMMEDIATE_AVAILABILITY_COPY as
    { question: string; answer: string } | undefined;

  assert.ok(IMMEDIATE_AVAILABILITY_COPY);
  assert.match(IMMEDIATE_AVAILABILITY_COPY!.question, /오늘/);
  assert.match(IMMEDIATE_AVAILABILITY_COPY!.question, /내일/);
  assert.doesNotMatch(IMMEDIATE_AVAILABILITY_COPY!.question, /시작일/);
  assert.match(IMMEDIATE_AVAILABILITY_COPY!.answer, /오늘|내일/);
  assert.doesNotMatch(
    `${IMMEDIATE_AVAILABILITY_COPY!.question} ${IMMEDIATE_AVAILABILITY_COPY!.answer}`,
    /(확정|배정|합격|출근)/,
  );
});
