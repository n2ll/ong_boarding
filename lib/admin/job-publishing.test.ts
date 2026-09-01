import assert from "node:assert/strict";
import test from "node:test";

import {
  JOB_PUBLISH_CHANNELS,
  buildExistingPoolSearchAction,
  buildJobApplicationUrl,
} from "./job-publishing.ts";

test("manual publishing choices exclude channels that do not allow the attributed application link", () => {
  assert.deepEqual(
    JOB_PUBLISH_CHANNELS.map((channel) => channel.source),
    ["facebook", "albamon", "jobkorea", "openchat", "referral", "direct"],
  );
  assert.equal(
    new Set(JOB_PUBLISH_CHANNELS.map((channel) => channel.source)).size,
    JOB_PUBLISH_CHANNELS.length,
  );
});

test("Meta advertising gets an attributed link without claiming automated campaign execution", () => {
  const meta = JOB_PUBLISH_CHANNELS.find((channel) => channel.source === "facebook");
  assert.deepEqual(meta, { source: "facebook", label: "Meta 광고" });
  assert.doesNotMatch(meta?.label ?? "", /자동|집행 중|게시 완료/);
});

test("a publishing URL keeps job and channel attribution without a false branch", () => {
  assert.equal(
    buildJobApplicationUrl({
      origin: "https://ong.example.com/",
      jobId: 42,
      source: "albamon",
      branch: "성수 1센터",
    }),
    "https://ong.example.com/apply?source=albamon&job=42&branch=%EC%84%B1%EC%88%98+1%EC%84%BC%ED%84%B0",
  );
  assert.equal(
    buildJobApplicationUrl({
      origin: "https://ong.example.com",
      jobId: "43",
      source: "albamon",
      branch: "-",
    }),
    "https://ong.example.com/apply?source=albamon&job=43",
  );
});

test("a publishing URL includes its opaque ref without dropping job, source, or branch", () => {
  const trackingRef = "91e65ed2-aa20-4f2a-8442-14d11c788ca2";
  const applicationUrl = new URL(buildJobApplicationUrl({
    origin: "https://ong.example.com/",
    jobId: 42,
    source: "facebook",
    branch: "성수 1센터",
    trackingRef,
  }));

  assert.equal(applicationUrl.pathname, "/apply");
  assert.equal(applicationUrl.searchParams.get("ref"), trackingRef);
  assert.equal(applicationUrl.searchParams.get("job"), "42");
  assert.equal(applicationUrl.searchParams.get("source"), "facebook");
  assert.equal(applicationUrl.searchParams.get("branch"), "성수 1센터");
});

test("an unfilled internal job continues to the existing-pool selection context", () => {
  const action = buildExistingPoolSearchAction({
    jobId: 42,
    effectivelyClosed: false,
    recruitMode: "internal",
    remaining: 3,
    needsCandidateSourcing: true,
  });

  assert.deepEqual(action, {
    href: "/pipeline?job=42",
    label: "인력풀에서 남은 3명 찾기",
    description: "맞춤 공고를 보여줄 대상을 선별하세요",
  });
  assert.doesNotMatch(`${action?.label} ${action?.description}`, /확정|배정/);
});

test("a combined recruitment job still starts with the existing pool", () => {
  assert.deepEqual(buildExistingPoolSearchAction({
    jobId: 51,
    effectivelyClosed: false,
    recruitMode: "both",
    remaining: 2,
    needsCandidateSourcing: true,
  }), {
    href: "/pipeline?job=51",
    label: "인력풀에서 남은 2명 찾기",
    description: "맞춤 공고를 보여줄 대상을 선별하세요",
  });
});

test("pool selection never replaces an active candidate task or an external-only job action", () => {
  for (const input of [
    {
      jobId: 42,
      effectivelyClosed: false,
      recruitMode: "external",
      remaining: 3,
      needsCandidateSourcing: true,
    },
    {
      jobId: 42,
      effectivelyClosed: true,
      recruitMode: "internal",
      remaining: 3,
      needsCandidateSourcing: true,
    },
    {
      jobId: 42,
      effectivelyClosed: false,
      recruitMode: "internal",
      remaining: 3,
      needsCandidateSourcing: false,
    },
    {
      jobId: 42,
      effectivelyClosed: false,
      recruitMode: "internal",
      remaining: 0,
      needsCandidateSourcing: true,
    },
  ]) {
    assert.equal(buildExistingPoolSearchAction(input), null);
  }
});

test("the jobs table uses the pool action href instead of an unsupported platform shortcut", async () => {
  const { readFile } = await import("node:fs/promises");
  const jobsSource = await readFile(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const rowStart = jobsSource.indexOf("filteredJobs.map(job => {");
  const rowEnd = jobsSource.indexOf("{/* AI JD Generator Modal */}", rowStart);
  const rowSource = jobsSource.slice(rowStart, rowEnd);

  assert.match(rowSource, /buildExistingPoolSearchAction\(/);
  assert.match(rowSource, /router\.push\(poolSearchAction\.href\)/);
  assert.match(rowSource, /poolSearchAction \? "border-brand-yellow\/55 bg-brand-muted\/55 text-foreground"/);
  assert.doesNotMatch(rowSource, /poolSearchAction \? "border-copilot/);
  assert.doesNotMatch(rowSource, /copyJobLink\(job, "danggeun"\)/);
  assert.doesNotMatch(rowSource, /당근 지원 링크 복사/);
});
