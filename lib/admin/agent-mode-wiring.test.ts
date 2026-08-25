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
