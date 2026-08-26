import assert from "node:assert/strict";
import test from "node:test";

test("current posting locations override reusable client and branch context", async () => {
  const contextModule = await import("./job-posting-context.ts");
  const buildContext = contextModule.buildCurrentJobPostingLocationContext;
  const formatLocation = contextModule.formatCurrentJobPostingLocation;

  assert.equal(typeof buildContext, "function");
  assert.equal(typeof formatLocation, "function");
  if (typeof buildContext !== "function" || typeof formatLocation !== "function") return;

  const input = {
    pickupAddress: "  성수동 물류센터 3번 게이트  ",
    dropoffAddress: "하남 미사강변도시 일대 · 종료 미사역",
  };

  assert.equal(
    buildContext(input),
    [
      "[이번 공고 입력 위치 — 화주사·지점 마스터와 다르면 아래 값을 우선합니다]",
      "상차지·집결지: 성수동 물류센터 3번 게이트",
      "배송 권역·마지막 경유지: 하남 미사강변도시 일대 · 종료 미사역",
    ].join("\n"),
  );
  assert.equal(
    formatLocation(input),
    "상차·집결 성수동 물류센터 3번 게이트 / 배송·종료 하남 미사강변도시 일대 · 종료 미사역",
  );
});

test("blank current posting locations add no false context", async () => {
  const contextModule = await import("./job-posting-context.ts");

  assert.equal(
    contextModule.buildCurrentJobPostingLocationContext({
      pickupAddress: "   ",
      dropoffAddress: "",
    }),
    undefined,
  );
  assert.equal(
    contextModule.formatCurrentJobPostingLocation({
      pickupAddress: "   ",
      dropoffAddress: "",
    }),
    "",
  );
});
