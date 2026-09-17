import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboard = readFileSync(new URL("../../components/Dashboard.tsx", import.meta.url), "utf8");

test("dashboard AI status never defaults an unknown or stale response to automatic", () => {
  assert.match(dashboard, /useSWR<AdminAgentModeResponse>/);
  assert.match(dashboard, /agentModeView\(\{ data: killRes, error: killError \}\)/);
  assert.match(dashboard, /agentModePresentation\(globalAgentMode\)/);
  assert.match(dashboard, /agentModeCopy\.detail/);
  assert.match(dashboard, /agentModeCopy\.canRetry/);
  assert.match(dashboard, /killValidating/);
  assert.match(dashboard, /mutateKillMode/);
  assert.doesNotMatch(dashboard, /killRes\.mode \?\? "auto"/);
  assert.doesNotMatch(dashboard, /\{aiMode && \(/);
});
