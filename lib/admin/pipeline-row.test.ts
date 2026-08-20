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
  columnCount: number;
  hideSecondaryColumns: boolean;
  minWidthClass: string;
};

async function loadRowModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./pipeline-row.js";
    return await import(modulePath) as Record<string, unknown>;
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

test("split review keeps only identity and current status in the narrow list", async () => {
  const row = await loadRowModule();
  const pipelineTableLayout = row.pipelineTableLayout as
    | ((splitPanelActive: boolean) => TableLayout)
    | undefined;

  assert.equal(typeof pipelineTableLayout, "function");
  assert.deepEqual(
    pipelineTableLayout!(true),
    { columnCount: 3, hideSecondaryColumns: true, minWidthClass: "min-w-[500px]" },
  );
  assert.deepEqual(
    pipelineTableLayout!(false),
    { columnCount: 7, hideSecondaryColumns: false, minWidthClass: "min-w-[1060px]" },
  );
});
