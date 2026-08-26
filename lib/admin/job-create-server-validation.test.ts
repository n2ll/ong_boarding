import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("job updates merge partial fields with current values before enforcing the same required contract", async () => {
  const validationModule = await import("./job-create-server-validation.ts").catch(() => null);
  const validate = validationModule?.validateJobUpdateRequiredFields;

  assert.equal(typeof validate, "function", "server-side job update validation should exist");
  if (typeof validate !== "function") return;

  const current = {
    capacity: 3,
    pickup_address: "성수동 물류센터",
    dropoff_address: "하남 미사 일대",
    pay_info: "건당 3,500원 · 매주 금요일 정산",
  };

  assert.equal(validate({ status: "closed" }, current), null, "status-only updates stay independent");
  assert.equal(validate({ capacity: 0 }, current)?.field, "capacity");
  assert.equal(validate({ pickup_address: " " }, current)?.field, "pickupAddress");
  assert.equal(validate({ dropoff_address: null }, current)?.field, "dropoffAddress");
  assert.equal(validate({ pay_info: null }, current)?.field, "payInfo");
  assert.equal(validate({ capacity: 4 }, current), null);
});

test("the job PATCH route applies required-field validation before persistence", () => {
  const route = readFileSync(
    new URL("../../app/api/admin/jobs/[id]/route.ts", import.meta.url),
    "utf8",
  );

  const validation = route.indexOf("validateJobUpdateRequiredFields(");
  const persistence = route.indexOf('.from("jobs")\n    .update(update)');
  assert.ok(validation >= 0, "PATCH should call the shared update validator");
  assert.ok(persistence > validation, "required-field validation must run before the update query");
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

test("job update routing preserves explicitly submitted inactive relationships when ids are unchanged", async () => {
  const validationModule = await import("./job-create-server-validation.ts").catch(() => null);
  const validate = validationModule?.validateJobUpdateRouting;

  assert.equal(typeof validate, "function", "server-side job update routing validation should exist");
  if (typeof validate !== "function") return;

  assert.equal(
    validate({
      currentClientId: 7,
      currentBranchId: 11,
      requestedClientId: 7,
      requestedBranchId: 11,
      branch: { id: 11, name: "기존점", client_id: 7, active: false },
      client: { id: 7, active: false },
    }),
    null,
  );
});

test("job update routing rejects a newly selected inactive client", async () => {
  const validationModule = await import("./job-create-server-validation.ts").catch(() => null);
  const validate = validationModule?.validateJobUpdateRouting;

  assert.equal(typeof validate, "function", "server-side job update routing validation should exist");
  if (typeof validate !== "function") return;

  assert.match(
    validate({
      currentClientId: 7,
      currentBranchId: null,
      requestedClientId: 8,
      requestedBranchId: undefined,
      branch: null,
      client: { id: 8, active: false },
    })?.error ?? "",
    /화주사.*비활성/,
  );
});

test("job update routing rejects changing or clearing the client while the linked branch stays", async () => {
  const validationModule = await import("./job-create-server-validation.ts").catch(() => null);
  const validate = validationModule?.validateJobUpdateRouting;

  assert.equal(typeof validate, "function", "server-side job update routing validation should exist");
  if (typeof validate !== "function") return;

  for (const requestedBranchId of [undefined, 11]) {
    for (const requestedClientId of [8, null]) {
      assert.match(
        validate({
          currentClientId: 7,
          currentBranchId: 11,
          requestedClientId,
          requestedBranchId,
          branch: null,
          client: requestedClientId === 8 ? { id: 8, active: true } : null,
        })?.error ?? "",
        /지점/,
      );
    }
  }
});

test("job update routing accepts a client change when the old branch is cleared", async () => {
  const validationModule = await import("./job-create-server-validation.ts").catch(() => null);
  const validate = validationModule?.validateJobUpdateRouting;

  assert.equal(typeof validate, "function", "server-side job update routing validation should exist");
  if (typeof validate !== "function") return;

  assert.equal(
    validate({
      currentClientId: 7,
      currentBranchId: 11,
      requestedClientId: 8,
      requestedBranchId: null,
      branch: null,
      client: { id: 8, active: true },
    }),
    null,
  );
});

test("job update routing rejects a newly selected inactive branch or inactive parent client", async () => {
  const validationModule = await import("./job-create-server-validation.ts").catch(() => null);
  const validate = validationModule?.validateJobUpdateRouting;

  assert.equal(typeof validate, "function", "server-side job update routing validation should exist");
  if (typeof validate !== "function") return;

  assert.match(
    validate({
      currentClientId: 7,
      currentBranchId: 11,
      requestedClientId: 8,
      requestedBranchId: 12,
      branch: { id: 12, name: "신규점", client_id: 8, active: false },
      client: { id: 8, active: true },
    })?.error ?? "",
    /지점.*비활성/,
  );
  assert.match(
    validate({
      currentClientId: 7,
      currentBranchId: 11,
      requestedClientId: 8,
      requestedBranchId: 12,
      branch: { id: 12, name: "신규점", client_id: 8, active: true },
      client: { id: 8, active: false },
    })?.error ?? "",
    /화주사.*비활성/,
  );
});

test("job update routing rejects a new branch whose explicitly requested client is different", async () => {
  const validationModule = await import("./job-create-server-validation.ts").catch(() => null);
  const validate = validationModule?.validateJobUpdateRouting;

  assert.equal(typeof validate, "function", "server-side job update routing validation should exist");
  if (typeof validate !== "function") return;

  assert.match(
    validate({
      currentClientId: 7,
      currentBranchId: 11,
      requestedClientId: 9,
      requestedBranchId: 12,
      branch: { id: 12, name: "신규점", client_id: 8, active: true },
      client: { id: 8, active: true },
    })?.error ?? "",
    /지점.*화주사|화주사.*지점/,
  );
});

test("job update routing accepts a newly selected active branch and its active client", async () => {
  const validationModule = await import("./job-create-server-validation.ts").catch(() => null);
  const validate = validationModule?.validateJobUpdateRouting;

  assert.equal(typeof validate, "function", "server-side job update routing validation should exist");
  if (typeof validate !== "function") return;

  assert.equal(
    validate({
      currentClientId: 7,
      currentBranchId: 11,
      requestedClientId: 8,
      requestedBranchId: 12,
      branch: { id: 12, name: "신규점", client_id: 8, active: true },
      client: { id: 8, active: true },
    }),
    null,
  );
});
