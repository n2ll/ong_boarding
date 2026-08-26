import assert from "node:assert/strict";
import test from "node:test";

test("job create server rejects missing operational fields before persistence", async () => {
  const validationModule = await import("./job-create-server-validation.ts").catch(() => null);
  const validate = validationModule?.validateJobCreateRequiredFields;

  assert.equal(typeof validate, "function", "server-side job create validation should exist");
  if (typeof validate !== "function") return;

  const valid = {
    capacity: 3,
    pickupAddress: "성수동 물류센터 3번 게이트",
    dropoffAddress: "하남 미사강변도시 일대",
    payInfo: "건당 3,500원 · 매주 금요일 정산",
  };

  assert.match(validate({ ...valid, capacity: 0 })?.error ?? "", /모집 인원/);
  assert.match(validate({ ...valid, capacity: 1.5 })?.error ?? "", /모집 인원/);
  assert.match(validate({ ...valid, pickupAddress: "   " })?.error ?? "", /상차지/);
  assert.match(validate({ ...valid, dropoffAddress: null })?.error ?? "", /배송/);
  assert.match(validate({ ...valid, payInfo: undefined })?.error ?? "", /급여/);
  assert.equal(validate(valid), null);
});

test("job create routing rejects malformed optional ids", async () => {
  const validationModule = await import("./job-create-server-validation.ts").catch(() => null);
  const resolve = validationModule?.resolveJobCreateRouting;

  assert.equal(typeof resolve, "function", "server-side job routing validation should exist");
  if (typeof resolve !== "function") return;

  assert.equal(resolve({ requestedClientId: "7", requestedBranchId: null, branch: null, client: null }).ok, false);
  assert.equal(resolve({ requestedClientId: null, requestedBranchId: -1, branch: null, client: null }).ok, false);
});

test("job create routing only accepts active clients and owned active branches", async () => {
  const validationModule = await import("./job-create-server-validation.ts").catch(() => null);
  const resolve = validationModule?.resolveJobCreateRouting;

  assert.equal(typeof resolve, "function", "server-side job routing validation should exist");
  if (typeof resolve !== "function") return;

  const activeClient = { id: 7, active: true };
  const activeBranch = { id: 11, name: "강남점", client_id: 7, active: true };

  assert.match(
    resolve({ requestedClientId: 7, requestedBranchId: null, branch: null, client: null }).error ?? "",
    /화주사/,
  );
  assert.match(
    resolve({
      requestedClientId: 7,
      requestedBranchId: null,
      branch: null,
      client: { id: 7, active: false },
    }).error ?? "",
    /비활성/,
  );
  assert.match(
    resolve({
      requestedClientId: 7,
      requestedBranchId: 11,
      branch: { ...activeBranch, active: false },
      client: activeClient,
    }).error ?? "",
    /지점.*비활성/,
  );
  assert.match(
    resolve({
      requestedClientId: 8,
      requestedBranchId: 11,
      branch: activeBranch,
      client: activeClient,
    }).error ?? "",
    /소속/,
  );
  assert.match(
    resolve({
      requestedClientId: null,
      requestedBranchId: 11,
      branch: { ...activeBranch, client_id: null },
      client: null,
    }).error ?? "",
    /소속 화주사/,
  );

  assert.deepEqual(
    resolve({
      requestedClientId: null,
      requestedBranchId: 11,
      branch: activeBranch,
      client: activeClient,
    }),
    { ok: true, branchId: 11, branchName: "강남점", clientId: 7 },
  );
});

test("job create routing preserves the optional no-client general-line contract", async () => {
  const validationModule = await import("./job-create-server-validation.ts").catch(() => null);
  const resolve = validationModule?.resolveJobCreateRouting;

  assert.equal(typeof resolve, "function", "server-side job routing validation should exist");
  if (typeof resolve !== "function") return;

  assert.deepEqual(
    resolve({
      requestedClientId: null,
      requestedBranchId: null,
      requestedBranchName: "자유 입력 권역",
      branch: null,
      client: null,
    }),
    { ok: true, branchId: null, branchName: "자유 입력 권역", clientId: null },
  );
});
