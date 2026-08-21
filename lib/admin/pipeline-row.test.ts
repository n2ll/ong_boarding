import assert from "node:assert/strict";
import test from "node:test";

type AvailabilityMeta = {
  label: string;
  tone: "success" | "info" | "muted";
  freshness: string | null;
};

type ContactMeta = {
  primary: string;
  campaign: string | null;
};

type TableLayout = {
  mode: "narrow" | "core" | "wide";
  columnCount: number;
  showCoreColumns: boolean;
  showWideColumns: boolean;
  minWidthClass: string;
};

async function loadRowModule(): Promise<Record<string, unknown>> {
  try {
    return await import(new URL("./pipeline-row.ts", import.meta.url).href) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("known availability includes a human label and its confirmation age", async () => {
  const row = await loadRowModule();
  const pipelineAvailabilityMeta = row.pipelineAvailabilityMeta as
    | ((value: string | null, updatedAt: string | null, nowMs: number) => AvailabilityMeta)
    | undefined;

  assert.equal(typeof pipelineAvailabilityMeta, "function");
  assert.deepEqual(
    pipelineAvailabilityMeta!(
      "즉시가능",
      "2026-08-18T00:00:00.000Z",
      Date.parse("2026-08-20T00:00:00.000Z"),
    ),
    { label: "즉시 가능", tone: "success", freshness: "확인 2일 전" },
  );
});

test("missing or unsupported availability is presented as unconfirmed", async () => {
  const row = await loadRowModule();
  const pipelineAvailabilityMeta = row.pipelineAvailabilityMeta as
    | ((value: string | null, updatedAt: string | null, nowMs: number) => AvailabilityMeta)
    | undefined;

  assert.equal(typeof pipelineAvailabilityMeta, "function");
  assert.deepEqual(
    pipelineAvailabilityMeta!("알 수 없음", null, Date.parse("2026-08-20T00:00:00.000Z")),
    { label: "미확인", tone: "muted", freshness: null },
  );
});

test("recent contact distinguishes applicant replies from campaign sends", async () => {
  const row = await loadRowModule();
  const pipelineContactMeta = row.pipelineContactMeta as
    | ((lastReplyAt: string | null, lastPingAt: string | null, nowMs: number) => ContactMeta)
    | undefined;

  assert.equal(typeof pipelineContactMeta, "function");
  assert.deepEqual(
    pipelineContactMeta!(
      "2026-08-18T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
      Date.parse("2026-08-20T00:00:00.000Z"),
    ),
    { primary: "지원자 답장 2일 전", campaign: "캠페인 발송 10일 전" },
  );
  assert.deepEqual(
    pipelineContactMeta!(null, null, Date.parse("2026-08-20T00:00:00.000Z")),
    { primary: "지원자 답장 없음", campaign: null },
  );
});

test("a 1024-class content area keeps four operational columns without supplementary detail", async () => {
  const row = await loadRowModule();
  const pipelineTableLayout = row.pipelineTableLayout as
    | ((contentWidth: number | null, splitPanelActive: boolean) => TableLayout)
    | undefined;

  assert.equal(typeof pipelineTableLayout, "function");
  assert.deepEqual(
    pipelineTableLayout!(840, false),
    {
      mode: "core",
      columnCount: 5,
      showCoreColumns: true,
      showWideColumns: false,
      minWidthClass: "min-w-[760px]",
    },
  );
});

test("supplementary vehicle and source columns require genuinely wide content", async () => {
  const row = await loadRowModule();
  const pipelineTableLayout = row.pipelineTableLayout as
    | ((contentWidth: number | null, splitPanelActive: boolean) => TableLayout)
    | undefined;

  assert.equal(typeof pipelineTableLayout, "function");
  assert.deepEqual(
    pipelineTableLayout!(1039, false),
    {
      mode: "core",
      columnCount: 5,
      showCoreColumns: true,
      showWideColumns: false,
      minWidthClass: "min-w-[760px]",
    },
  );
  assert.deepEqual(
    pipelineTableLayout!(1040, false),
    {
      mode: "wide",
      columnCount: 7,
      showCoreColumns: true,
      showWideColumns: true,
      minWidthClass: "min-w-[1040px]",
    },
  );
});

test("split review stays narrow even while its outer desktop viewport is wide", async () => {
  const row = await loadRowModule();
  const pipelineTableLayout = row.pipelineTableLayout as
    | ((contentWidth: number | null, splitPanelActive: boolean) => TableLayout)
    | undefined;

  assert.equal(typeof pipelineTableLayout, "function");
  assert.deepEqual(
    pipelineTableLayout!(1200, true),
    {
      mode: "narrow",
      columnCount: 3,
      showCoreColumns: false,
      showWideColumns: false,
      minWidthClass: "min-w-[500px]",
    },
  );
});

test("the list width observer waits for a renderable list surface", async () => {
  const row = await loadRowModule();
  const pipelineListSurfaceReady = row.pipelineListSurfaceReady as
    | ((view: string, state: string, hasSnapshot: boolean) => boolean)
    | undefined;

  assert.equal(typeof pipelineListSurfaceReady, "function");
  assert.equal(pipelineListSurfaceReady!("list", "loading", false), true);
  assert.equal(pipelineListSurfaceReady!("list", "error", false), false);
  assert.equal(pipelineListSurfaceReady!("list", "error", true), true);
  assert.equal(pipelineListSurfaceReady!("kanban", "ready", true), false);
});

test("docked split review drops the secondary jobs shortcut before core tools", async () => {
  const row = await loadRowModule();
  const showPipelineJobsShortcut = row.showPipelineJobsShortcut as
    | ((splitPanelActive: boolean) => boolean)
    | undefined;

  assert.equal(typeof showPipelineJobsShortcut, "function");
  assert.equal(showPipelineJobsShortcut!(false), true);
  assert.equal(showPipelineJobsShortcut!(true), false);
});
