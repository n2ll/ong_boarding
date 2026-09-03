import assert from "node:assert/strict";
import test from "node:test";

type JobTrackingSubmissionsModule = {
  jobTrackingSubmissionLabel?: (count: number | null) => string;
};

async function loadModule(): Promise<JobTrackingSubmissionsModule> {
  try {
    return await import(new URL("./job-tracking-submissions.ts", import.meta.url).href) as JobTrackingSubmissionsModule;
  } catch {
    return {};
  }
}

test("tracking submission labels keep a failed aggregate distinct from zero submissions", async () => {
  const { jobTrackingSubmissionLabel } = await loadModule();

  assert.equal(typeof jobTrackingSubmissionLabel, "function");
  assert.equal(jobTrackingSubmissionLabel!(0), "추적 링크 지원 0건");
  assert.equal(jobTrackingSubmissionLabel!(4), "추적 링크 지원 4건");
  assert.equal(jobTrackingSubmissionLabel!(null), "추적 링크 지원 확인 불가");
});
