import assert from "node:assert/strict";
import test from "node:test";

type GatherMessagePreviews = (
  supabase: unknown,
  ids: number[],
  options?: { throwOnCoreError?: boolean },
) => Promise<Record<number, unknown>>;

async function loadGather(): Promise<GatherMessagePreviews | undefined> {
  try {
    const previewModule = await import(new URL("./message-preview.ts", import.meta.url).href);
    return previewModule.gatherMessagePreviews as GatherMessagePreviews;
  } catch {
    return undefined;
  }
}

function failingMessageClient() {
  const query = {
    select() { return this; },
    in() { return this; },
    order() { return this; },
    range() { return Promise.resolve({ data: null, error: new Error("messages unavailable") }); },
  };
  return { from: () => query };
}

test("strict preview callers can distinguish a core query failure from a true empty result", async () => {
  const gatherMessagePreviews = await loadGather();

  assert.equal(typeof gatherMessagePreviews, "function");
  await assert.rejects(
    gatherMessagePreviews!(failingMessageClient(), [1], { throwOnCoreError: true }),
    /messages unavailable/,
  );
});

test("legacy supplementary callers keep the existing empty fallback", async () => {
  const gatherMessagePreviews = await loadGather();

  assert.equal(typeof gatherMessagePreviews, "function");
  assert.deepEqual(await gatherMessagePreviews!(failingMessageClient(), [1]), {});
});
