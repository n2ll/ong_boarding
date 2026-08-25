import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function componentSource(name: string): string {
  return readFileSync(new URL(`../../components/${name}`, import.meta.url), "utf8");
}

test("every manager conversation receives the shared remote AI mode state", () => {
  const thread = componentSource("ConversationThread.tsx");
  const live = componentSource("LiveConsole.tsx");
  const detail = componentSource("ApplicantDetailPanel.tsx");

  assert.match(thread, /agentMode: AdminAgentModeView/);
  assert.match(thread, /agentModeAllowsManualSend\(agentMode\)/);
  assert.match(thread, /if \(!canSend\)[\s\S]*?문자를 보내지/);
  assert.match(live, /agentMode=\{globalAgentMode\}/);
  assert.match(detail, /agentMode=\{drawerAgentMode\}/);
});

test("bulk screening rechecks a no-store AI mode response before dispatch", () => {
  const jobs = componentSource("Jobs.tsx");
  const dispatchStart = jobs.indexOf("const dispatchUnsent = async () =>");
  const freshCheck = jobs.indexOf("const latestAgentMode = await fetchFreshAgentMode()", dispatchStart);
  const readyGate = jobs.indexOf('if (latestAgentMode.state !== "ready")', freshCheck);
  const dispatchRequest = jobs.indexOf("/dispatch`, {", readyGate);

  assert.ok(dispatchStart >= 0);
  assert.ok(freshCheck > dispatchStart);
  assert.ok(readyGate > freshCheck);
  assert.ok(dispatchRequest > readyGate);
});

test("AI settings derive from validated snapshots and never inject a false environment state", () => {
  const brain = componentSource("AgentBrain.tsx");
  const automation = componentSource("Automation.tsx");
  const route = readFileSync(new URL("../../app/api/admin/agent/kill-switch/route.ts", import.meta.url), "utf8");
  const postRoute = route.slice(route.indexOf("export async function POST"));
  const updateMutation = postRoute.slice(
    postRoute.indexOf(".update({ body, updated_at: updatedAt })"),
    postRoute.indexOf("if (updateError)"),
  );

  assert.match(brain, /agentModeSnapshot\(killApi\)/);
  assert.match(brain, /agentModeView\(\{ data: killApi, error: killError \}\)/);
  assert.match(brain, /isAdminAgentModeResponse\(json\)/);
  assert.doesNotMatch(brain, /useState<BrainMode>\("auto"\)/);
  assert.doesNotMatch(brain, /env_forced: false/);
  assert.match(postRoute, /env_forced:/);
  assert.match(postRoute, /const updatedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(postRoute, /\.update\(\{ body, updated_at: updatedAt \}\)/);
  assert.match(postRoute, /\.insert\(\{ category: CATEGORY, title: TITLE, body, sort_order: 0, updated_at: updatedAt \}\)/);
  assert.match(postRoute, /updated_at: updatedAt/);
  assert.match(postRoute, /const storedMode = parseAgentMode\(stored\?\.body\)/);
  assert.doesNotMatch(updateMutation, /\.limit\(/);
  assert.match(automation, /AI 응답 모드/);
  assert.match(automation, /agentMode: agentModeView\(\{ data: killRes, error: killError \}\)/);
  assert.match(automation, /claimsAutomatic/);
  assert.match(automation, /live: stats\.ai\.claimsAutomatic/);
  assert.match(automation, /hasHardOverviewError/);
  assert.doesNotMatch(automation, /label: "AI 자동응답"/);
});

test("the AI mode storage row is hidden and protected from generic prompt CRUD", () => {
  const brain = componentSource("AgentBrain.tsx");
  const collectionRoute = readFileSync(new URL("../../app/api/admin/prompt-examples/route.ts", import.meta.url), "utf8");
  const itemRoute = readFileSync(new URL("../../app/api/admin/prompt-examples/[id]/route.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../docs/migrations/2026-08-agent-kill-switch-reservation.sql", import.meta.url), "utf8");

  assert.match(brain, /isReservedPromptExampleKey\(e\.category, e\.title\)/);
  assert.match(collectionRoute, /isReservedPromptExampleKey\(category, title\)/);
  assert.match(collectionRoute, /filter\(\(row\) => !isReservedPromptExampleKey\(row\.category, row\.title\)\)/);
  assert.match(itemRoute, /isReservedPromptExampleKey\(current\.category, current\.title\)/);
  assert.match(itemRoute, /isReservedPromptExampleKey\(current\.category, nextTitle\)/);
  assert.match(migration, /CREATE UNIQUE INDEX/);
  assert.match(migration, /WHERE category = 'system_message' AND title = 'agent_kill_switch'/);
  assert.match(migration, /WHEN '' THEN '0'/);
  assert.match(migration, /WHEN '0' THEN '0'/);
  assert.match(migration, /ELSE '1'/);
});
