import assert from "node:assert/strict";
import test from "node:test";

type HandoffNavigationModule = {
  liveHandoffGroupFocus?: (
    groups: Array<Array<{
      applicant_id: number;
      job_id: number;
      job_title: string;
      paused_at: string | null;
    }>>,
    applicantId: number | null,
  ) => {
    applicantId: number;
    jobId: number;
    jobLink: {
      job_id: number;
      title: string;
      branch: null;
      agent_stage: "paused";
      created_at: null;
      stage_updated_at: string | null;
    };
  } | null;
};

async function loadModule(): Promise<HandoffNavigationModule> {
  try {
    return await import(new URL("./live-handoff-navigation.ts", import.meta.url).href) as HandoffNavigationModule;
  } catch {
    return {};
  }
}

test("automatic handoff advance focuses the next applicant group's exact head job", async () => {
  const { liveHandoffGroupFocus } = await loadModule();

  assert.equal(typeof liveHandoffGroupFocus, "function");
  assert.deepEqual(liveHandoffGroupFocus!([
    [
      { applicant_id: 12, job_id: 301, job_title: "오전 배송", paused_at: "2026-08-20T01:00:00.000Z" },
      { applicant_id: 12, job_id: 302, job_title: "오후 배송", paused_at: "2026-08-21T01:00:00.000Z" },
    ],
    [
      // 시스템·마감 공고처럼 살아있는 결속에서 빠진 행도, 큐가 지목한 예외 탭으로 그대로 연다.
      { applicant_id: 19, job_id: 990, job_title: "__미지정 공고", paused_at: "2026-08-22T01:00:00.000Z" },
      { applicant_id: 19, job_id: 401, job_title: "후순위 공고", paused_at: "2026-08-23T01:00:00.000Z" },
    ],
  ], 19), {
    applicantId: 19,
    jobId: 990,
    jobLink: {
      job_id: 990,
      title: "__미지정 공고",
      branch: null,
      agent_stage: "paused",
      created_at: null,
      stage_updated_at: "2026-08-22T01:00:00.000Z",
    },
  });
  assert.equal(liveHandoffGroupFocus!([], null), null);
});
