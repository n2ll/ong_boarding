import assert from "node:assert/strict";
import test from "node:test";

type TeamDirectoryModule = {
  teamDirectoryView?: (input: {
    members?: unknown[];
    branches?: unknown[];
    memberError?: unknown;
    branchError?: unknown;
  }) =>
    | { state: "loading" }
    | { state: "error"; sources: string[] }
    | { state: "ready"; count: number };
};

async function loadModule(): Promise<TeamDirectoryModule> {
  try {
    return await import(new URL("./team-directory.ts", import.meta.url).href) as TeamDirectoryModule;
  } catch {
    return {};
  }
}

test("the team directory does not render an empty list before both sources load", async () => {
  const { teamDirectoryView } = await loadModule();

  assert.equal(typeof teamDirectoryView, "function");
  assert.deepEqual(teamDirectoryView!({ members: [] }), { state: "loading" });
});

test("team dependency failures stay explicit instead of looking empty", async () => {
  const { teamDirectoryView } = await loadModule();

  assert.equal(typeof teamDirectoryView, "function");
  assert.deepEqual(teamDirectoryView!({
    members: [],
    branches: [],
    branchError: new Error("offline"),
  }), { state: "error", sources: ["branches"] });
});

test("a loaded empty team is the only state reported as zero", async () => {
  const { teamDirectoryView } = await loadModule();

  assert.equal(typeof teamDirectoryView, "function");
  assert.deepEqual(teamDirectoryView!({ members: [], branches: [] }), { state: "ready", count: 0 });
});
