import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboard = readFileSync(new URL("../../components/Dashboard.tsx", import.meta.url), "utf8");

test("common manager desktops use available width for triage and work queues", () => {
  assert.equal(
    dashboard.includes("grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3"),
    true,
    "task cards should progress from one to two to three columns before the 1440px sidebar expands",
  );
  assert.equal(
    dashboard.includes("xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]"),
    true,
    "the primary and supporting work queues should split at 1280px",
  );
  assert.equal(
    dashboard.includes("wide:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]"),
    false,
    "the work queue split must not wait for the narrower 1440px content shell",
  );
});

test("task states, cards, and skeleton follow the same responsive layout contract", () => {
  assert.equal(
    (dashboard.match(/lg:col-span-2 xl:col-span-3/g) ?? []).length,
    3,
    "loading, error, and empty task states should fill the responsive grid",
  );
  assert.equal(dashboard.includes("lg:min-h-[148px]"), true);
  assert.equal(dashboard.includes("lg:h-full lg:flex-col lg:items-stretch lg:gap-3"), true);
  assert.equal(dashboard.includes("h-[420px] rounded-lg xl:h-[270px]"), true);
  assert.equal(
    dashboard.includes("업무 유형 {urgent.length}개"),
    true,
    "the badge must identify that it counts work types rather than individual cases",
  );
});
