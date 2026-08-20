import assert from "node:assert/strict";
import test from "node:test";

type Candidate = { phone: string; name: string | null };
type SelectionModule = {
  reengagementCandidateKey?: (phone: string) => string;
  selectedReengagementCandidates?: <T extends Candidate>(candidates: T[], keys: string[]) => T[];
};

async function loadModule(): Promise<SelectionModule> {
  try {
    return await import(new URL("./reengagement-selection.ts", import.meta.url).href) as SelectionModule;
  } catch {
    return {};
  }
}

test("candidate keys are deterministic without exposing the phone number", async () => {
  const { reengagementCandidateKey } = await loadModule();

  assert.equal(typeof reengagementCandidateKey, "function");
  const key = reengagementCandidateKey!("01012345678");
  assert.equal(key, reengagementCandidateKey!("01012345678"));
  assert.equal(key.includes("01012345678"), false);
  assert.match(key, /^[a-f0-9]{16}$/);
});

test("an empty or unknown selection never falls back to importing everyone", async () => {
  const { selectedReengagementCandidates } = await loadModule();
  const candidates = [
    { phone: "01011112222", name: "김하나" },
    { phone: "01033334444", name: "이둘" },
  ];

  assert.equal(typeof selectedReengagementCandidates, "function");
  assert.deepEqual(selectedReengagementCandidates!(candidates, []), []);
  assert.deepEqual(selectedReengagementCandidates!(candidates, ["unknown"]), []);
});

test("only explicitly selected candidates are returned for import", async () => {
  const { reengagementCandidateKey, selectedReengagementCandidates } = await loadModule();
  const candidates = [
    { phone: "01011112222", name: "김하나" },
    { phone: "01033334444", name: "이둘" },
  ];

  assert.equal(typeof reengagementCandidateKey, "function");
  assert.equal(typeof selectedReengagementCandidates, "function");
  assert.deepEqual(
    selectedReengagementCandidates!(candidates, [reengagementCandidateKey!("01033334444")]),
    [{ phone: "01033334444", name: "이둘" }],
  );
});
