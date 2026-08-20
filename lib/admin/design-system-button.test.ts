import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Button asChild gives Radix Slot exactly the caller child", async () => {
  const componentUrl = new URL("../../components/ui/button.tsx", import.meta.url);
  const source = await readFile(componentUrl, "utf8");

  assert.match(
    source,
    /if \(asChild\) \{[\s\S]*?<Slot[\s\S]*?>\s*\{children\}\s*<\/Slot>[\s\S]*?\}/,
    "asChild must return a dedicated Slot branch whose only child is the caller child",
  );
  assert.doesNotMatch(
    source,
    /isLoading\s*&&\s*!asChild/,
    "a false loading expression still counts as a second Radix Slot child",
  );
});
