import assert from "node:assert/strict";
import test from "node:test";

import {
  JOB_PUBLISH_CHANNELS,
  buildExternalPublishingBundle,
  buildExistingPoolSearchAction,
  buildJobApplicationUrl,
  jobPublicPublishingAvailability,
} from "./job-publishing.ts";

test("only a currently open public external job can prepare a publishing link", () => {
  assert.deepEqual(jobPublicPublishingAvailability({
    title: "성수 배송",
    status: "active",
    exposure: "all",
    recruitMode: "external",
    closesAt: "2999-09-04T00:00:00.000Z",
  }), {
    available: true,
  });
  assert.equal(jobPublicPublishingAvailability({
    title: "성수 배송",
    status: "active",
    exposure: "all",
    recruitMode: "both",
    closesAt: null,
  }).available, true);
});

test("targeted, internal, system, invalid, and closed jobs fail closed for public publishing", () => {
  const cases = [
    {
      job: { title: "성수 배송", status: "active", exposure: "targeted", recruitMode: "external", closesAt: null },
      reason: "hidden",
      description: "지정 노출 공고는 공개 지원 링크를 만들 수 없어요.",
    },
    {
      job: { title: "성수 배송", status: "active", exposure: "all", recruitMode: "internal", closesAt: null },
      reason: "hidden",
      description: "내부 모집 공고는 공개 지원 링크를 만들 수 없어요.",
    },
    {
      job: { title: "__시스템 공고", status: "active", exposure: "all", recruitMode: "external", closesAt: null },
      reason: "hidden",
      description: "시스템 공고는 공개 지원 링크를 만들 수 없어요.",
    },
    {
      job: { title: " ", status: "active", exposure: "all", recruitMode: "external", closesAt: null },
      reason: "hidden",
      description: "공고 상태를 안전하게 확인할 수 없어요.",
    },
    {
      job: { title: "성수 배송", status: "closed", exposure: "all", recruitMode: "external", closesAt: null },
      reason: "closed",
      description: "진행 중이고 마감 전인 공고에서만 지원 링크를 만들 수 있어요.",
    },
    {
      job: { title: "성수 배송", status: "active", exposure: "all", recruitMode: "external", closesAt: "2000-09-03T00:00:00.000Z" },
      reason: "closed",
      description: "진행 중이고 마감 전인 공고에서만 지원 링크를 만들 수 있어요.",
    },
  ] as const;

  for (const fixture of cases) {
    assert.deepEqual(jobPublicPublishingAvailability(fixture.job), {
      available: false,
      reason: fixture.reason,
      description: fixture.description,
    });
  }
});

test("an external publishing bundle trims the body and keeps the application action explicit", () => {
  assert.equal(buildExternalPublishingBundle({
    body: "  배송 기사님을 모집합니다.\n근무 조건을 확인해주세요.  ",
    url: " https://ong.example.com/apply?job=42 ",
  }), "배송 기사님을 모집합니다.\n근무 조건을 확인해주세요.\n\n지원하기: https://ong.example.com/apply?job=42");
});

test("an external publishing bundle with no body returns only the labelled application URL", () => {
  assert.equal(buildExternalPublishingBundle({
    body: "  ",
    url: "https://ong.example.com/apply?job=42",
  }), "지원하기: https://ong.example.com/apply?job=42");
});

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
