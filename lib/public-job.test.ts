import assert from "node:assert/strict";
import test from "node:test";

type PublicJobModule = {
  publicJobAvailability?: (job: {
    title: string | null;
    status: string | null;
    exposure: string | null;
    recruitMode: string | null;
    closesAt?: string | null;
  }, nowMs?: number) => "open" | "closed" | "hidden";
};

async function loadPublicJobModule(): Promise<PublicJobModule> {
  try {
    const modulePath = "./public-job.ts";
    return await import(modulePath) as PublicJobModule;
  } catch {
    return {};
  }
}

test("only active external or mixed-channel jobs accept public applicants", async () => {
  const { publicJobAvailability } = await loadPublicJobModule();

  assert.equal(typeof publicJobAvailability, "function");
  assert.equal(publicJobAvailability!({ title: "성수 배송", status: "active", exposure: "all", recruitMode: "external" }), "open");
  assert.equal(publicJobAvailability!({ title: "성수 배송", status: "active", exposure: "all", recruitMode: "both" }), "open");
  assert.equal(publicJobAvailability!({ title: "성수 배송", status: "closed", exposure: "all", recruitMode: "external" }), "closed");
  assert.equal(publicJobAvailability!({ title: "성수 배송", status: "paused", exposure: "all", recruitMode: "external" }), "closed");
});

test("system, targeted, and pool-only jobs stay hidden from public links", async () => {
  const { publicJobAvailability } = await loadPublicJobModule();

  assert.equal(typeof publicJobAvailability, "function");
  assert.equal(publicJobAvailability!({ title: "__당근 시스템", status: "active", exposure: "all", recruitMode: "external" }), "hidden");
  assert.equal(publicJobAvailability!({ title: "성수 배송", status: "active", exposure: "targeted", recruitMode: "external" }), "hidden");
  assert.equal(publicJobAvailability!({ title: "성수 배송", status: "active", exposure: "all", recruitMode: "internal" }), "hidden");
});

test("missing public-routing metadata fails closed", async () => {
  const { publicJobAvailability } = await loadPublicJobModule();

  assert.equal(typeof publicJobAvailability, "function");
  assert.equal(publicJobAvailability!({ title: null, status: "active", exposure: "all", recruitMode: "external" }), "hidden");
  assert.equal(publicJobAvailability!({ title: "성수 배송", status: null, exposure: "all", recruitMode: "external" }), "hidden");
  assert.equal(publicJobAvailability!({ title: "성수 배송", status: "active", exposure: "all", recruitMode: null }), "hidden");
});

test("an active job whose closing time has passed is closed to public applicants", async () => {
  const { publicJobAvailability } = await loadPublicJobModule();
  const now = Date.parse("2026-08-20T05:00:00.000Z");

  assert.equal(typeof publicJobAvailability, "function");
  assert.equal(publicJobAvailability!({
    title: "성수 배송",
    status: "active",
    exposure: "all",
    recruitMode: "external",
    closesAt: "2026-08-20T04:59:59.000Z",
  }, now), "closed");
  assert.equal(publicJobAvailability!({
    title: "성수 배송",
    status: "active",
    exposure: "all",
    recruitMode: "external",
    closesAt: "2026-08-20T05:00:01.000Z",
  }, now), "open");
});
