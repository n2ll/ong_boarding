import assert from "node:assert/strict";
import test from "node:test";

const adminNav = await import(new URL("./nav.ts", import.meta.url).href) as typeof import("./nav");

const { NAV_ITEMS, resolveHeader } = adminNav;

test("manager navigation exposes one applicant-operations entry", () => {
  const operationsItems = NAV_ITEMS.filter((item) =>
    ["/live", "/inbox", "/live?tab=confirm"].includes(item.path),
  );

  assert.deepEqual(
    operationsItems.map(({ label, path }) => ({ label, path })),
    [{ label: "지원자 운영", path: "/live" }],
  );
});

test("live workspace uses task-oriented header copy", () => {
  assert.deepEqual(resolveHeader("/live"), {
    pageTitle: "지원자 운영",
    crumb: "채용 운영 > 지원자 운영",
  });
});

test("navigation separates the people pool from job-centered recruiting", () => {
  const roleItems = NAV_ITEMS.filter((item) => ["/pipeline", "/jobs"].includes(item.path));

  assert.deepEqual(
    roleItems.map(({ label, path }) => ({ label, path })),
    [
      { label: "인재풀", path: "/pipeline" },
      { label: "채용공고", path: "/jobs" },
    ],
  );
  assert.deepEqual(resolveHeader("/pipeline"), {
    pageTitle: "인재풀",
    crumb: "인재 관리 > 인재풀",
  });
  assert.deepEqual(resolveHeader("/jobs"), {
    pageTitle: "채용공고",
    crumb: "채용 운영 > 채용공고",
  });
});

test("pipeline view links preserve filters and keep the default URL clean", () => {
  const pipelineViewHref = (adminNav as Record<string, unknown>).pipelineViewHref as
    | ((view: "list" | "kanban" | "map" | "funnel", currentSearch?: string) => string)
    | undefined;

  assert.equal(typeof pipelineViewHref, "function");
  assert.equal(pipelineViewHref!("list", "?q=kim&view=map"), "/pipeline?q=kim");
  assert.equal(
    pipelineViewHref!("kanban", "?q=kim&region=seoul"),
    "/pipeline?q=kim&region=seoul&view=kanban",
  );
});

test("pipeline restores a valid view from a shared URL before rendering", () => {
  const pipelineViewFromSearch = (adminNav as Record<string, unknown>).pipelineViewFromSearch as
    | ((currentSearch?: string) => "list" | "kanban" | "map" | "funnel")
    | undefined;

  assert.equal(typeof pipelineViewFromSearch, "function");
  assert.equal(pipelineViewFromSearch!("?view=kanban"), "kanban");
  assert.equal(pipelineViewFromSearch!("?view=unknown"), "list");
});

test("pipeline core filters survive sharing and can be cleared without losing other context", () => {
  const pipelineCoreFilterHref = (adminNav as Record<string, unknown>).pipelineCoreFilterHref as
    | ((currentSearch: string, statuses: string[], availability: string[]) => string)
    | undefined;

  assert.equal(typeof pipelineCoreFilterHref, "function");
  const href = pipelineCoreFilterHref!(
    "?view=map&q=kim",
    ["스크리닝 전", "스크리닝 완료"],
    ["즉시가능"],
  );
  const shared = new URL(href, "https://admin.example.com");
  assert.equal(shared.pathname, "/pipeline");
  assert.equal(shared.searchParams.get("view"), "map");
  assert.equal(shared.searchParams.get("q"), "kim");
  assert.equal(shared.searchParams.get("status"), "스크리닝 전,스크리닝 완료");
  assert.equal(shared.searchParams.get("availability"), "즉시가능");

  const cleared = new URL(pipelineCoreFilterHref!(shared.search, [], []), "https://admin.example.com");
  assert.equal(cleared.searchParams.get("view"), "map");
  assert.equal(cleared.searchParams.get("q"), "kim");
  assert.equal(cleared.searchParams.has("status"), false);
  assert.equal(cleared.searchParams.has("availability"), false);
});

test("pipeline ignores unsupported core filter values from a URL", () => {
  const pipelineCoreFiltersFromSearch = (adminNav as Record<string, unknown>)
    .pipelineCoreFiltersFromSearch as
    | ((currentSearch: string) => { statuses: string[]; availability: string[] })
    | undefined;

  assert.equal(typeof pipelineCoreFiltersFromSearch, "function");
  assert.deepEqual(
    pipelineCoreFiltersFromSearch!(
      "?status=스크리닝 전,잘못된 단계&availability=즉시가능,알 수 없음",
    ),
    { statuses: ["스크리닝 전"], availability: ["즉시가능"] },
  );
});

test("changing one pipeline core filter preserves the other filter from the current URL", () => {
  const pipelineCoreFilterPatchHref = (adminNav as Record<string, unknown>)
    .pipelineCoreFilterPatchHref as
    | ((currentSearch: string, patch: { statuses?: string[]; availability?: string[] }) => string)
    | undefined;

  assert.equal(typeof pipelineCoreFilterPatchHref, "function");
  const statusHref = pipelineCoreFilterPatchHref!("", { statuses: ["스크리닝 전"] });
  const statusSearch = new URL(statusHref, "https://admin.example.com").search;
  const combinedHref = pipelineCoreFilterPatchHref!(statusSearch, { availability: ["즉시가능"] });
  const combined = new URL(combinedHref, "https://admin.example.com");

  assert.equal(combined.searchParams.get("status"), "스크리닝 전");
  assert.equal(combined.searchParams.get("availability"), "즉시가능");
});

const nextQueueApplicantId = (adminNav as Record<string, unknown>)
  .nextQueueApplicantId as
  | ((previousIds: number[], currentIds: number[], selectedId: number | null) => number | null)
  | undefined;

test("a completed queue item advances to the next surviving applicant", () => {
  assert.equal(typeof nextQueueApplicantId, "function");
  assert.equal(nextQueueApplicantId!([11, 12, 13], [12, 13], 11), 12);
  assert.equal(nextQueueApplicantId!([11, 12, 13], [11, 13], 12), 13);
  assert.equal(nextQueueApplicantId!([11, 12, 13], [99, 11, 13], 12), 13);
});

test("a completed last queue item falls back to the nearest previous applicant", () => {
  assert.equal(nextQueueApplicantId!([11, 12, 13], [11, 12], 13), 12);
});

test("queue refresh preserves a valid or externally opened selection", () => {
  assert.equal(nextQueueApplicantId!([11, 12], [11, 12], 11), 11);
  assert.equal(nextQueueApplicantId!([11, 12], [11, 12], 99), 99);
});

test("queue completion clears the selection when no work remains", () => {
  assert.equal(nextQueueApplicantId!([11], [], 11), null);
});
