import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type PageResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

type PaginationModule = {
  fetchAllPostgrestRows?: <T>(
    fetchPage: (from: number, to: number) => Promise<PageResult<T>>,
    label: string,
  ) => Promise<T[]>;
};

async function loadModule(): Promise<PaginationModule> {
  try {
    return await import(new URL("./postgrest-pagination.ts", import.meta.url).href) as PaginationModule;
  } catch {
    return {};
  }
}

test("reads every row after the PostgREST 1000-row boundary", async () => {
  const { fetchAllPostgrestRows } = await loadModule();
  assert.equal(typeof fetchAllPostgrestRows, "function");
  if (typeof fetchAllPostgrestRows !== "function") return;

  const source = Array.from({ length: 1_001 }, (_, index) => ({ id: index + 1 }));
  const windows: Array<[number, number]> = [];
  const rows = await fetchAllPostgrestRows(async (from, to) => {
    windows.push([from, to]);
    return { data: source.slice(from, to + 1), error: null };
  }, "candidate aggregate");

  assert.equal(rows.length, 1_001);
  assert.deepEqual([rows[0].id, rows[999].id, rows[1_000].id], [1, 1_000, 1_001]);
  assert.deepEqual(windows, [[0, 999], [1_000, 1_999]]);
});

test("rejects a later page error instead of returning a partial aggregate", async () => {
  const { fetchAllPostgrestRows } = await loadModule();
  assert.equal(typeof fetchAllPostgrestRows, "function");
  if (typeof fetchAllPostgrestRows !== "function") return;

  let pages = 0;
  await assert.rejects(
    fetchAllPostgrestRows(async () => {
      pages += 1;
      if (pages === 1) {
        return {
          data: Array.from({ length: 1_000 }, (_, index) => ({ id: index + 1 })),
          error: null,
        };
      }
      return { data: null, error: { message: "database unavailable" } };
    }, "interest aggregate"),
    /interest aggregate.*database unavailable/,
  );
  assert.equal(pages, 2);
});

test("rejects a malformed success payload instead of treating it as an empty page", async () => {
  const { fetchAllPostgrestRows } = await loadModule();
  assert.equal(typeof fetchAllPostgrestRows, "function");
  if (typeof fetchAllPostgrestRows !== "function") return;

  await assert.rejects(
    fetchAllPostgrestRows(async () => ({ data: null, error: null }), "job candidates"),
    /job candidates.*응답 형식/,
  );
});

test("candidate board fails only for candidate pages and degrades optional job geo to null", () => {
  const routeSource = readFileSync(
    new URL("../../app/api/admin/jobs/[id]/candidates/route.ts", import.meta.url),
    "utf8",
  );
  const getSource = routeSource.slice(
    routeSource.indexOf("export async function GET"),
    routeSource.indexOf("export async function POST"),
  );

  assert.match(getSource, /Promise\.allSettled\(/);
  assert.match(
    getSource,
    /candidateResult\.status === "rejected"[\s\S]*?return NextResponse\.json\(\{ error: "조회 실패" \}, \{ status: 500 \}\)/,
  );
  assert.match(
    getSource,
    /jobResult\.status === "rejected"[\s\S]*?job = null[\s\S]*?jobResult\.value\.error[\s\S]*?job = null/,
  );

  const optionalGeoHandling = getSource.slice(
    getSource.indexOf('if (jobResult.status === "rejected")'),
    getSource.indexOf("const candidates = rows.map"),
  );
  assert.doesNotMatch(optionalGeoHandling, /return NextResponse\.json|throw new Error/);
});
