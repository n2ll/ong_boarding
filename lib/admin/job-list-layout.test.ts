import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type JobListSummaryInput = {
  openJobs: number;
  remaining: number;
  unconfiguredCapacity: number;
  attention: number;
  reviewReady: number;
};

type JobListSummaryItem = {
  key: "attention" | "reviewReady" | "remaining" | "openJobs";
  label: string;
  value: number | null;
  unit: "명" | "건";
  note: string;
  tone: "critical" | "screening" | "onboarding" | "active" | "neutral";
  unavailableReason: "loading" | "error" | null;
};

async function loadLayoutModule(): Promise<Record<string, unknown>> {
  try {
    return await import(new URL("./job-list-layout.ts", import.meta.url).href) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("manager-action metrics precede portfolio totals and use operational tones", async () => {
  const layout = await loadLayoutModule();
  const buildJobListSummary = layout.buildJobListSummary as
    | ((input: JobListSummaryInput, state: "ready" | "loading" | "error") => JobListSummaryItem[])
    | undefined;

  assert.equal(typeof buildJobListSummary, "function");
  assert.deepEqual(
    buildJobListSummary!({
      openJobs: 4,
      remaining: 7,
      unconfiguredCapacity: 2,
      attention: 3,
      reviewReady: 5,
    }, "ready"),
    [
      {
        key: "attention",
        label: "사람 확인",
        value: 3,
        unit: "명",
        note: "수동 응대 · 응대 시작 전",
        tone: "critical",
        unavailableReason: null,
      },
      {
        key: "reviewReady",
        label: "후보 검토",
        value: 5,
        unit: "명",
        note: "스크리닝 완료 · 매니저 판단 대기",
        tone: "onboarding",
        unavailableReason: null,
      },
      {
        key: "remaining",
        label: "남은 충원",
        value: 7,
        unit: "명",
        note: "정원 미설정 2건 별도",
        tone: "screening",
        unavailableReason: null,
      },
      {
        key: "openJobs",
        label: "진행 공고",
        value: 4,
        unit: "건",
        note: "현재 모집 · 응대 중",
        tone: "active",
        unavailableReason: null,
      },
    ],
  );
});

test("loading and error summaries stay unknown instead of reporting zero work", async () => {
  const layout = await loadLayoutModule();
  const buildJobListSummary = layout.buildJobListSummary as
    | ((input: JobListSummaryInput, state: "ready" | "loading" | "error") => JobListSummaryItem[])
    | undefined;
  const empty: JobListSummaryInput = {
    openJobs: 0,
    remaining: 0,
    unconfiguredCapacity: 0,
    attention: 0,
    reviewReady: 0,
  };

  assert.equal(typeof buildJobListSummary, "function");
  assert.deepEqual(
    buildJobListSummary!(empty, "loading").map(({ value, unavailableReason }) => ({ value, unavailableReason })),
    Array.from({ length: 4 }, () => ({ value: null, unavailableReason: "loading" })),
  );
  assert.deepEqual(
    buildJobListSummary!(empty, "error").map(({ value, unavailableReason }) => ({ value, unavailableReason })),
    Array.from({ length: 4 }, () => ({ value: null, unavailableReason: "error" })),
  );
});

test("zero-value metrics remain calm when no manager action is pending", async () => {
  const layout = await loadLayoutModule();
  const buildJobListSummary = layout.buildJobListSummary as
    | ((input: JobListSummaryInput, state: "ready" | "loading" | "error") => JobListSummaryItem[])
    | undefined;

  assert.equal(typeof buildJobListSummary, "function");
  assert.deepEqual(
    buildJobListSummary!({
      openJobs: 0,
      remaining: 0,
      unconfiguredCapacity: 0,
      attention: 0,
      reviewReady: 0,
    }, "ready").map(({ key, tone }) => ({ key, tone })),
    [
      { key: "attention", tone: "neutral" },
      { key: "reviewReady", tone: "neutral" },
      { key: "remaining", tone: "neutral" },
      { key: "openJobs", tone: "neutral" },
    ],
  );
});

test("the jobs header and every desktop row share one responsive grid contract", () => {
  const jobs = readFileSync(new URL("../../components/Jobs.tsx", import.meta.url), "utf8");

  assert.equal(/Table Header[\s\S]*?lg:grid \$\{JOB_LIST_GRID\}/.test(jobs), true, "header must use JOB_LIST_GRID");
  assert.equal(
    /key=\{job\.id\}[\s\S]{0,500}?className=\{`[^`]*\$\{JOB_LIST_GRID\}[^`]*`\}/.test(jobs),
    true,
    "desktop rows must use the same JOB_LIST_GRID contract",
  );
  assert.equal(/grid-cols-\[1\.9fr_0\.9fr_0\.9fr/.test(jobs), false, "legacy six-column row grid must be removed");
});

test("the jobs status filter uses the shared controlled Radix tab contract", () => {
  const jobs = readFileSync(new URL("../../components/Jobs.tsx", import.meta.url), "utf8");

  assert.match(jobs, /import \{ Tabs, TabsList, TabsTrigger \} from "\.\/ui\/tabs"/);
  assert.match(jobs, /<Tabs[\s\S]*?value=\{activeTab\}[\s\S]*?onValueChange=\{\(value\) => setActiveTab\(value as JobListTab\)\}[\s\S]*?activationMode="automatic"/);
  assert.match(jobs, /<TabsList[^>]*aria-label="공고 상태"/);
  assert.match(jobs, /<TabsTrigger[^>]*value="all"[^>]*aria-controls="jobs-list-panel"/);
  assert.match(jobs, /<TabsTrigger[^>]*value="active"[^>]*aria-controls="jobs-list-panel"/);
  assert.match(jobs, /<TabsTrigger[^>]*value="closed"[^>]*aria-controls="jobs-list-panel"/);
  assert.match(jobs, /data-\[state=active\]:bg-foreground/);
  assert.match(jobs, /data-\[state=active\]:text-white/);
  assert.match(jobs, /id="jobs-list-panel"[^>]*role="tabpanel"[^>]*aria-labelledby=\{`jobs-tab-\$\{activeTab\}`\}/);
});

test("job summary explanations stay readable instead of truncating at 11px", () => {
  const jobs = readFileSync(new URL("../../components/Jobs.tsx", import.meta.url), "utf8");

  assert.match(jobs, /line-clamp-2[^"\n]*text-\[12px\][^"\n]*leading-4[^>]*>\{item\.note\}/);
  assert.doesNotMatch(jobs, /truncate text-\[11px\][^>]*>\{item\.note\}/);
});
