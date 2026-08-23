import assert from "node:assert/strict";
import test from "node:test";

type RuleConfig = Record<string, { enabled: boolean; threshold?: number }>;
type SaveResult =
  | { ok: true; config: RuleConfig }
  | { ok: false; error: string };
type Request = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

async function loadActionModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./automation-config-action.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("saving automation config returns the server-normalized config", async () => {
  const action = await loadActionModule();
  const saveAutomationConfig = action.saveAutomationConfig as
    | ((config: RuleConfig, request: Request) => Promise<SaveResult>)
    | undefined;
  const requested: { url?: string; init?: RequestInit } = {};
  const input = { waiting_backlog: { enabled: true, threshold: 7 } };
  const normalized = { waiting_backlog: { enabled: true, threshold: 5 } };

  assert.equal(typeof saveAutomationConfig, "function");
  const result = await saveAutomationConfig!(input, async (url, init) => {
    requested.url = url;
    requested.init = init;
    return { ok: true, json: async () => ({ config: normalized }) };
  });

  assert.deepEqual(result, { ok: true, config: normalized });
  assert.equal(requested.url, "/api/admin/automation/rules");
  assert.equal(requested.init?.method, "PUT");
  assert.equal(requested.init?.body, JSON.stringify({ config: input }));
});

test("a non-OK response is a failed save with the server message", async () => {
  const action = await loadActionModule();
  const saveAutomationConfig = action.saveAutomationConfig as
    | ((config: RuleConfig, request: Request) => Promise<SaveResult>)
    | undefined;

  assert.equal(typeof saveAutomationConfig, "function");
  const result = await saveAutomationConfig!({}, async () => ({
    ok: false,
    json: async () => ({ error: "저장 권한이 없습니다." }),
  }));

  assert.deepEqual(result, { ok: false, error: "저장 권한이 없습니다." });
});

test("a network error is a failed save instead of a silent success", async () => {
  const action = await loadActionModule();
  const saveAutomationConfig = action.saveAutomationConfig as
    | ((config: RuleConfig, request: Request) => Promise<SaveResult>)
    | undefined;

  assert.equal(typeof saveAutomationConfig, "function");
  const result = await saveAutomationConfig!({}, async () => {
    throw new Error("offline");
  });

  assert.deepEqual(result, { ok: false, error: "규칙 저장에 실패했어요." });
});
