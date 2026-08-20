import assert from "node:assert/strict";
import test from "node:test";

type JobOperationInput = {
  effectivelyClosed: boolean;
  capacity: number;
  confirmed: number;
  waiting: number;
  paused: number;
  reviewReady: number;
  inProgress: number;
};

type JobOperationMeta = {
  remaining: number | null;
  fillPercent: number | null;
  attention: number;
  nextAction: {
    label: string;
    description: string;
    tone: "success" | "danger" | "warning" | "info" | "muted";
  };
};

async function loadOperationsModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./job-operations.js";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("manual attention outranks automated progress on an open job", async () => {
  const operations = await loadOperationsModule();
  const jobOperationMeta = operations.jobOperationMeta as
    | ((input: JobOperationInput) => JobOperationMeta)
    | undefined;

  assert.equal(typeof jobOperationMeta, "function");
  assert.deepEqual(
    jobOperationMeta!({
      effectivelyClosed: false,
      capacity: 5,
      confirmed: 2,
      waiting: 2,
      paused: 1,
      reviewReady: 1,
      inProgress: 4,
    }),
    {
      remaining: 3,
      fillPercent: 40,
      attention: 3,
      nextAction: {
        label: "사람 확인 3명",
        description: "수동 응대 1명 · 응대 시작 전 2명",
        tone: "danger",
      },
    },
  );
});

test("screening-complete candidates are framed as manager review, not confirmation", async () => {
  const operations = await loadOperationsModule();
  const jobOperationMeta = operations.jobOperationMeta as
    | ((input: JobOperationInput) => JobOperationMeta)
    | undefined;

  assert.equal(typeof jobOperationMeta, "function");
  assert.deepEqual(
    jobOperationMeta!({
      effectivelyClosed: false,
      capacity: 4,
      confirmed: 1,
      waiting: 0,
      paused: 0,
      reviewReady: 2,
      inProgress: 3,
    }).nextAction,
    {
      label: "후보 검토 2명",
      description: "스크리닝 완료 · 확정 여부는 매니저 판단",
      tone: "info",
    },
  );
});

test("review-ready counts exclude already confirmed people", async () => {
  const operations = await loadOperationsModule();
  const isReviewReadyCandidate = operations.isReviewReadyCandidate as
    | ((stage: string | null, applicantStatus: string | null) => boolean)
    | undefined;

  assert.equal(typeof isReviewReadyCandidate, "function");
  assert.equal(isReviewReadyCandidate!("onboarding", "스크리닝 완료"), true);
  assert.equal(isReviewReadyCandidate!("active", "스크리닝 완료"), true);
  assert.equal(isReviewReadyCandidate!("active", "확정인력"), false);
  assert.equal(isReviewReadyCandidate!("screening", "스크리닝 중"), false);
});

test("filled capacity becomes the first operational action", async () => {
  const operations = await loadOperationsModule();
  const jobOperationMeta = operations.jobOperationMeta as
    | ((input: JobOperationInput) => JobOperationMeta)
    | undefined;

  assert.equal(typeof jobOperationMeta, "function");
  assert.deepEqual(
    jobOperationMeta!({
      effectivelyClosed: false,
      capacity: 2,
      confirmed: 2,
      waiting: 1,
      paused: 1,
      reviewReady: 0,
      inProgress: 1,
    }),
    {
      remaining: 0,
      fillPercent: 100,
      attention: 2,
      nextAction: {
        label: "충원 완료",
        description: "정원 2명 충원 · 공고 마감 검토",
        tone: "success",
      },
    },
  );
});

test("portfolio summary only counts open-job work", async () => {
  const operations = await loadOperationsModule();
  const jobOperationsSummary = operations.jobOperationsSummary as
    | ((jobs: JobOperationInput[]) => {
      openJobs: number;
      remaining: number;
      unconfiguredCapacity: number;
      attention: number;
      reviewReady: number;
    })
    | undefined;

  assert.equal(typeof jobOperationsSummary, "function");
  assert.deepEqual(
    jobOperationsSummary!([
      { effectivelyClosed: false, capacity: 5, confirmed: 2, waiting: 2, paused: 1, reviewReady: 1, inProgress: 4 },
      { effectivelyClosed: false, capacity: 0, confirmed: 0, waiting: 0, paused: 0, reviewReady: 2, inProgress: 2 },
      { effectivelyClosed: true, capacity: 10, confirmed: 0, waiting: 7, paused: 3, reviewReady: 4, inProgress: 5 },
    ]),
    {
      openJobs: 2,
      remaining: 3,
      unconfiguredCapacity: 1,
      attention: 3,
      reviewReady: 3,
    },
  );
});

test("a closed job candidate board is explicitly read-only", async () => {
  const operations = await loadOperationsModule();
  const jobCandidateBoardPolicy = operations.jobCandidateBoardPolicy as
    | ((effectivelyClosed: boolean) => {
      readOnly: boolean;
      label: string | null;
      allowDispatch: boolean;
      allowCandidateMutation: boolean;
    })
    | undefined;

  assert.equal(typeof jobCandidateBoardPolicy, "function");
  assert.deepEqual(jobCandidateBoardPolicy!(true), {
    readOnly: true,
    label: "마감 공고 · 조회만 가능",
    allowDispatch: false,
    allowCandidateMutation: false,
  });
  assert.deepEqual(jobCandidateBoardPolicy!(false), {
    readOnly: false,
    label: null,
    allowDispatch: true,
    allowCandidateMutation: true,
  });
});
