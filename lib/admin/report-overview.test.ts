import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

type ApplicantRow = {
  status: string;
  created_at: string | null;
  airtable_record_id?: string | null;
};

type UsageRow = { total_cost_krw: number | null };

type ReportOverviewModule = {
  reportOverview?: (input: {
    applicants?: ApplicantRow[];
    usage?: UsageRow[];
    errors?: Partial<Record<"applicants" | "usage", unknown>>;
    range: "이번 주" | "이번 달" | "올해";
    now: Date;
  }) =>
    | { state: "loading"; pending: string[] }
    | { state: "error"; failed: string[] }
    | {
        state: "ready";
        total: number;
        screening: number;
        reviewReady: number;
        confirmed: number;
        costLast30Days: number;
        excludedImports: number;
        stages: { key: string; count: number }[];
        trend: { month: string; applicants: number; confirmed: number }[];
      };
};

async function loadModule(): Promise<ReportOverviewModule> {
  try {
    return await import(new URL("./report-overview.ts", import.meta.url).href) as ReportOverviewModule;
  } catch {
    return {};
  }
}

test("report asChild links expose one Slottable React element to Radix Slot", async () => {
  const reportsUrl = new URL("../../components/Reports.tsx", import.meta.url);
  const sourceText = await readFile(reportsUrl, "utf8");
  const sourceFile = ts.createSourceFile(
    reportsUrl.pathname,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: string[] = [];

  function meaningfulChildren(children: ts.NodeArray<ts.JsxChild>): ts.JsxChild[] {
    return children.filter((child) => !ts.isJsxText(child) || child.getText(sourceFile).trim() !== "");
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sourceFile) === "Button") {
      const usesAsChild = node.openingElement.attributes.properties.some(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === "asChild",
      );

      if (usesAsChild) {
        const buttonChildren = meaningfulChildren(node.children);
        const slottable = buttonChildren[0];
        const hasOneSlottableChild = buttonChildren.length === 1
          && ts.isJsxElement(slottable)
          && slottable.openingElement.tagName.getText(sourceFile) === "Slottable";
        const slottableChildren = hasOneSlottableChild ? meaningfulChildren(slottable.children) : [];
        const exposesOneLink = slottableChildren.length === 1
          && ts.isJsxElement(slottableChildren[0])
          && slottableChildren[0].openingElement.tagName.getText(sourceFile) === "Link";

        if (!hasOneSlottableChild || !exposesOneLink) {
          violations.push(`line ${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  assert.deepEqual(violations, []);
});

test("report totals stay unknown until both data sources have loaded", async () => {
  const { reportOverview } = await loadModule();

  assert.equal(typeof reportOverview, "function");
  assert.deepEqual(reportOverview!({
    applicants: [],
    range: "올해",
    now: new Date("2026-08-20T12:00:00+09:00"),
  }), { state: "loading", pending: ["usage"] });
});

test("failed report sources are named instead of becoming zero", async () => {
  const { reportOverview } = await loadModule();

  assert.equal(typeof reportOverview, "function");
  assert.deepEqual(reportOverview!({
    applicants: [],
    usage: [],
    errors: { applicants: new Error("offline"), usage: new Error("timeout") },
    range: "올해",
    now: new Date("2026-08-20T12:00:00+09:00"),
  }), { state: "error", failed: ["applicants", "usage"] });
});

test("loaded empty sources are the only state reported as zero", async () => {
  const { reportOverview } = await loadModule();

  assert.equal(typeof reportOverview, "function");
  const overview = reportOverview!({
    applicants: [],
    usage: [],
    range: "이번 달",
    now: new Date("2026-08-20T12:00:00+09:00"),
  });

  assert.equal(overview.state, "ready");
  if (overview.state !== "ready") return;
  assert.deepEqual({
    total: overview.total,
    screening: overview.screening,
    reviewReady: overview.reviewReady,
    confirmed: overview.confirmed,
    costLast30Days: overview.costLast30Days,
    excludedImports: overview.excludedImports,
  }, {
    total: 0,
    screening: 0,
    reviewReady: 0,
    confirmed: 0,
    costLast30Days: 0,
    excludedImports: 0,
  });
  assert.equal(overview.stages.reduce((sum, stage) => sum + stage.count, 0), 0);
  assert.equal(overview.trend.length, 6);
  assert.equal(overview.trend.every((month) => month.applicants === 0 && month.confirmed === 0), true);
});

test("the overview uses current status counts and excludes imported or invalid timestamps", async () => {
  const { reportOverview } = await loadModule();

  assert.equal(typeof reportOverview, "function");
  const overview = reportOverview!({
    applicants: [
      { status: "스크리닝 전", created_at: "2026-01-10T03:00:00Z" },
      { status: "스크리닝 중", created_at: "2026-02-10T03:00:00Z" },
      { status: "스크리닝 완료", created_at: "2026-03-10T03:00:00Z" },
      { status: "확정인력", created_at: "2026-04-10T03:00:00Z" },
      { status: "대기자", created_at: "2026-05-10T03:00:00Z" },
      { status: "부적합", created_at: "2026-06-10T03:00:00Z" },
      { status: "확정인력", created_at: "2026-07-10T03:00:00Z", airtable_record_id: "rec-1" },
      { status: "스크리닝 중", created_at: "not-a-date" },
      { status: "스크리닝 중", created_at: null },
    ],
    usage: [{ total_cost_krw: 1200.4 }, { total_cost_krw: null }, { total_cost_krw: 300 }],
    range: "올해",
    now: new Date("2026-08-20T12:00:00+09:00"),
  });

  assert.equal(overview.state, "ready");
  if (overview.state !== "ready") return;
  assert.deepEqual({
    total: overview.total,
    screening: overview.screening,
    reviewReady: overview.reviewReady,
    confirmed: overview.confirmed,
    costLast30Days: overview.costLast30Days,
    excludedImports: overview.excludedImports,
  }, {
    total: 6,
    screening: 1,
    reviewReady: 1,
    confirmed: 1,
    costLast30Days: 1500.4,
    excludedImports: 1,
  });
  assert.deepEqual(overview.stages, [
    { key: "received", count: 1 },
    { key: "screening", count: 1 },
    { key: "review", count: 1 },
    { key: "confirmed", count: 1 },
    { key: "other", count: 2 },
  ]);
  assert.deepEqual(overview.trend, [
    { month: "2026-03", applicants: 1, confirmed: 0 },
    { month: "2026-04", applicants: 1, confirmed: 1 },
    { month: "2026-05", applicants: 1, confirmed: 0 },
    { month: "2026-06", applicants: 1, confirmed: 0 },
    { month: "2026-07", applicants: 0, confirmed: 0 },
    { month: "2026-08", applicants: 0, confirmed: 0 },
  ]);
});

test("this week starts Monday in Korea regardless of the timestamp offset", async () => {
  const { reportOverview } = await loadModule();

  assert.equal(typeof reportOverview, "function");
  const overview = reportOverview!({
    applicants: [
      { status: "스크리닝 중", created_at: "2026-08-16T14:59:59Z" },
      { status: "스크리닝 완료", created_at: "2026-08-16T15:00:00Z" },
      { status: "확정인력", created_at: "2026-08-20T02:00:00Z" },
    ],
    usage: [],
    range: "이번 주",
    now: new Date("2026-08-20T12:00:00+09:00"),
  });

  assert.equal(overview.state, "ready");
  if (overview.state !== "ready") return;
  assert.deepEqual({ total: overview.total, reviewReady: overview.reviewReady, confirmed: overview.confirmed }, {
    total: 2,
    reviewReady: 1,
    confirmed: 1,
  });
});
