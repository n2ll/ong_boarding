import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = new URL("../../app/api/admin/notifications/route.ts", import.meta.url);

test("the notification route validates every query before computing queue health", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(source, /notificationQueryState\(\{/);
  assert.match(source, /killSwitch:\s*killSwitchRes/);
  assert.match(source, /queryState\.inboxCount/);
  assert.match(source, /queryState\.inboxOldestRows/);
  assert.match(source, /queryState\.handoffRows/);
  assert.match(source, /loadBulkMessageAttention/);
  assert.match(source, /bulkMessageAttentionPresentation\(bulkAttention\)/);
  assert.match(source, /bulk_message_attention:\s*bulkAttention/);
  assert.doesNotMatch(source, /isAgentDisabled/);
});
