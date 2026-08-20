import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

type RecommendationViewModule = {
  recommendationJobsView?: (input: {
    jobs?: unknown[];
    error?: unknown;
  }) =>
    | { state: "loading" }
    | { state: "error" }
    | { state: "empty" }
    | { state: "ready"; count: number };
  recommendationResultView?: (input: {
    requested: boolean;
    loading: boolean;
    error?: string | null;
    candidates?: unknown[];
  }) => "idle" | "loading" | "error" | "empty" | "ready";
  recommendationEvidence?: (input: {
    ownVehicle?: string | null;
    recencyAt?: string | null;
    createdAt?: string | null;
    score?: {
      total?: number | null;
      distance?: number | null;
      vehicle?: number | null;
      recency?: number | null;
      distanceKm?: number | null;
    } | null;
  }) => {
    total: number | null;
    distancePoints: number | null;
    vehiclePoints: number | null;
    recencyPoints: number | null;
    distanceKm: number | null;
    vehicle: "owned" | "not_owned" | "unknown";
    activityAt: string | null;
  };
  recommendationAddOutcome?: (input: {
    ok: boolean;
    added?: unknown;
    error?: unknown;
    partial?: unknown;
  }) => "added" | "already_added" | "partial_error" | "error";
  recommendationVehicleFit?: (
    vehicle: "owned" | "not_owned" | "unknown",
    required: boolean,
  ) => "meets" | "does_not_meet" | "needs_review" | "not_required";
};

async function loadModule(): Promise<RecommendationViewModule> {
  try {
    return await import(new URL("./recommendation-view.ts", import.meta.url).href) as RecommendationViewModule;
  } catch {
    return {};
  }
}

test("the empty-jobs navigation link does not enter the Button Radix Slot", async () => {
  const componentUrl = new URL("../../components/Recommendations.tsx", import.meta.url);
  const sourceText = await readFile(componentUrl, "utf8");
  const sourceFile = ts.createSourceFile(
    componentUrl.pathname,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let foundJobsLink = false;
  let jobsLinkUsesButtonSlot = false;

  const hasAttribute = (node: ts.JsxOpeningLikeElement, name: string) =>
    node.attributes.properties.some((attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === name
    );
  const isJobsLink = (node: ts.JsxElement) => {
    if (node.openingElement.tagName.getText(sourceFile) !== "Link") return false;
    return node.openingElement.attributes.properties.some((attribute) =>
      ts.isJsxAttribute(attribute)
      && attribute.name.getText(sourceFile) === "href"
      && attribute.initializer?.getText(sourceFile) === '"/jobs"'
    );
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && isJobsLink(node)) {
      foundJobsLink = true;
      let parent: ts.Node | undefined = node.parent;
      while (parent && !ts.isSourceFile(parent)) {
        if (
          ts.isJsxElement(parent)
          && parent.openingElement.tagName.getText(sourceFile) === "Button"
          && hasAttribute(parent.openingElement, "asChild")
        ) {
          jobsLinkUsesButtonSlot = true;
          break;
        }
        parent = parent.parent;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  assert.equal(foundJobsLink, true, "the empty state must keep its /jobs navigation");
  assert.equal(
    jobsLinkUsesButtonSlot,
    false,
    "Button adds a loading child before its asChild content, so this link would crash Radix Slot",
  );
});

test("the jobs pane distinguishes loading, failure, empty, and ready data", async () => {
  const { recommendationJobsView } = await loadModule();

  assert.equal(typeof recommendationJobsView, "function");
  assert.deepEqual(recommendationJobsView!({}), { state: "loading" });
  assert.deepEqual(recommendationJobsView!({ error: new Error("offline") }), { state: "error" });
  assert.deepEqual(recommendationJobsView!({ jobs: [] }), { state: "empty" });
  assert.deepEqual(recommendationJobsView!({ jobs: [{ id: 1 }] }), { state: "ready", count: 1 });
});

test("a finished recommendation request never presents a failure as an empty result", async () => {
  const { recommendationResultView } = await loadModule();

  assert.equal(typeof recommendationResultView, "function");
  assert.equal(recommendationResultView!({ requested: false, loading: false }), "idle");
  assert.equal(recommendationResultView!({ requested: true, loading: true }), "loading");
  assert.equal(recommendationResultView!({ requested: true, loading: false, error: "timeout", candidates: [] }), "error");
  assert.equal(recommendationResultView!({ requested: true, loading: false, candidates: [] }), "empty");
  assert.equal(recommendationResultView!({ requested: true, loading: false, candidates: [{}] }), "ready");
});

test("candidate evidence keeps missing distance, vehicle, recency, and score unknown", async () => {
  const { recommendationEvidence } = await loadModule();

  assert.equal(typeof recommendationEvidence, "function");
  assert.deepEqual(recommendationEvidence!({
    ownVehicle: "미입력",
    recencyAt: "not-a-date",
    createdAt: null,
    score: {
      total: Number.NaN,
      distance: Number.NaN,
      vehicle: Number.NaN,
      recency: Number.NaN,
      distanceKm: Number.POSITIVE_INFINITY,
    },
  }), {
    total: null,
    distancePoints: null,
    vehiclePoints: null,
    recencyPoints: null,
    distanceKm: null,
    vehicle: "unknown",
    activityAt: null,
  });
});

test("candidate evidence exposes the server's rule inputs without inventing an AI reason", async () => {
  const { recommendationEvidence } = await loadModule();

  assert.equal(typeof recommendationEvidence, "function");
  assert.deepEqual(recommendationEvidence!({
    ownVehicle: "있음",
    recencyAt: "2026-08-18T09:00:00.000Z",
    createdAt: "2024-01-01T00:00:00.000Z",
    score: { total: 100, distance: 70, vehicle: 20, recency: 10, distanceKm: 2.25 },
  }), {
    total: 100,
    distancePoints: 70,
    vehiclePoints: 20,
    recencyPoints: 10,
    distanceKm: 2.25,
    vehicle: "owned",
    activityAt: "2026-08-18T09:00:00.000Z",
  });
});

test("candidate add responses distinguish newly added, duplicate, and partial failures", async () => {
  const { recommendationAddOutcome } = await loadModule();

  assert.equal(typeof recommendationAddOutcome, "function");
  assert.equal(recommendationAddOutcome!({ ok: true, added: 1 }), "added");
  assert.equal(recommendationAddOutcome!({ ok: true, added: 0 }), "already_added");
  assert.equal(recommendationAddOutcome!({ ok: false, partial: true, error: "exposure failed" }), "partial_error");
  assert.equal(recommendationAddOutcome!({ ok: false, error: "request failed" }), "error");
});

test("vehicle evidence identifies required-condition misses and unknowns for manager review", async () => {
  const { recommendationVehicleFit } = await loadModule();

  assert.equal(typeof recommendationVehicleFit, "function");
  assert.equal(recommendationVehicleFit!("owned", true), "meets");
  assert.equal(recommendationVehicleFit!("not_owned", true), "does_not_meet");
  assert.equal(recommendationVehicleFit!("unknown", true), "needs_review");
  assert.equal(recommendationVehicleFit!("not_owned", false), "not_required");
});
