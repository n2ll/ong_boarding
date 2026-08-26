import assert from "node:assert/strict";
import test from "node:test";

import {
  filtersToRevealJob,
  jobListVisibility,
  type JobListFilterCandidate,
  type JobListFilters,
} from "./job-list-visibility.ts";

const job: JobListFilterCandidate = {
  title: "강남 새벽 배송원",
  branch: "역삼 집결",
  clientId: 7,
  branchId: 12,
  effectivelyClosed: false,
};

const visibleFilters: JobListFilters = {
  tab: "active",
  clientId: "",
  branchId: "",
  query: "",
};

test("job list visibility uses one contract for status, routing, and search filters", () => {
  assert.deepEqual(jobListVisibility(job, visibleFilters), { visible: true, hiddenBy: [] });
  assert.deepEqual(
    jobListVisibility(job, { tab: "closed", clientId: 99, branchId: 88, query: "서초" }),
    { visible: false, hiddenBy: ["status", "client", "branch", "query"] },
  );
  assert.deepEqual(
    jobListVisibility({ ...job, effectivelyClosed: true }, { ...visibleFilters, tab: "closed" }),
    { visible: true, hiddenBy: [] },
  );
});

test("job list search trims the query and matches either title or branch", () => {
  assert.equal(jobListVisibility(job, { ...visibleFilters, query: "  강남  " }).visible, true);
  assert.equal(jobListVisibility(job, { ...visibleFilters, query: "역삼" }).visible, true);
  assert.deepEqual(jobListVisibility(job, { ...visibleFilters, query: "송파" }).hiddenBy, ["query"]);
});

test("revealing a job clears only filters that actually hide it", () => {
  assert.deepEqual(
    filtersToRevealJob(job, {
      tab: "closed",
      clientId: 99,
      branchId: 12,
      query: "  역삼  ",
    }),
    {
      tab: "active",
      clientId: "",
      branchId: 12,
      query: "  역삼  ",
    },
  );
});
