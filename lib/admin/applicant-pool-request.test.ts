import assert from "node:assert/strict";
import test from "node:test";

type ApplicantPoolRequestModule = {
  fetchApplicantPool?: (fetcher: (input: string) => Promise<{
    ok: boolean;
    json: () => Promise<unknown>;
  }>) => Promise<unknown[]>;
};

async function loadModule(): Promise<ApplicantPoolRequestModule> {
  try {
    return await import(new URL("./applicant-pool-request.ts", import.meta.url).href) as ApplicantPoolRequestModule;
  } catch {
    return {};
  }
}

test("candidate pool rejects a non-2xx response instead of reporting an empty pool", async () => {
  const { fetchApplicantPool } = await loadModule();
  assert.equal(typeof fetchApplicantPool, "function");
  if (typeof fetchApplicantPool !== "function") return;

  await assert.rejects(
    fetchApplicantPool(async () => ({
      ok: false,
      json: async () => ({ data: [], error: "지원자 목록 집계 실패" }),
    })),
    /지원자 목록 집계 실패/,
  );
});

test("candidate pool rejects a malformed success payload instead of treating it as empty", async () => {
  const { fetchApplicantPool } = await loadModule();
  assert.equal(typeof fetchApplicantPool, "function");
  if (typeof fetchApplicantPool !== "function") return;

  await assert.rejects(
    fetchApplicantPool(async () => ({
      ok: true,
      json: async () => ({ count: 2 }),
    })),
    /응답 형식/,
  );
});

test("candidate pool returns the complete successful collection", async () => {
  const { fetchApplicantPool } = await loadModule();
  assert.equal(typeof fetchApplicantPool, "function");
  if (typeof fetchApplicantPool !== "function") return;

  const rows = [{ id: 11 }, { id: 12 }];
  assert.deepEqual(await fetchApplicantPool(async (input) => {
    assert.equal(input, "/api/admin/applicants");
    return { ok: true, json: async () => ({ data: rows }) };
  }), rows);
});
