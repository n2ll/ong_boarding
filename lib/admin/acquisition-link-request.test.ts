import assert from "node:assert/strict";
import test from "node:test";

import { JOB_PUBLISH_CHANNELS } from "./job-publishing.ts";

type AcquisitionLinkRequest =
  | {
      ok: true;
      jobId: number;
      source: string;
      campaignName: string;
      channelLabel: string;
    }
  | { ok: false; reason: "invalid_job" | "invalid_source" };

type AcquisitionLinkRequestModule = {
  parseAcquisitionLinkRequest?: (input: {
    jobId: unknown;
    source: unknown;
  }) => AcquisitionLinkRequest;
};

async function loadModule(): Promise<AcquisitionLinkRequestModule> {
  try {
    return await import(new URL("./acquisition-link-request.ts", import.meta.url).href) as AcquisitionLinkRequestModule;
  } catch {
    return {};
  }
}

test("every supported publishing channel produces a neutral tracking-link request", async () => {
  const { parseAcquisitionLinkRequest } = await loadModule();
  assert.equal(typeof parseAcquisitionLinkRequest, "function");

  for (const channel of JOB_PUBLISH_CHANNELS) {
    const parsed = parseAcquisitionLinkRequest!({ jobId: "42", source: channel.source });
    assert.deepEqual(parsed, {
      ok: true,
      jobId: 42,
      source: channel.source,
      campaignName: `${channel.label} 모집 링크`,
      channelLabel: channel.label,
    });
    if (parsed.ok) {
      assert.doesNotMatch(parsed.campaignName, /게시 완료|집행 중|자동 집행|연동 완료/);
    }
  }
});

test("invalid jobs and caller-invented sources fail closed", async () => {
  const { parseAcquisitionLinkRequest } = await loadModule();
  assert.equal(typeof parseAcquisitionLinkRequest, "function");

  for (const jobId of [null, "", "0", -1, 1.5, "not-a-job"]) {
    assert.deepEqual(parseAcquisitionLinkRequest!({ jobId, source: "facebook" }), {
      ok: false,
      reason: "invalid_job",
    });
  }
  for (const source of [null, "homepage", "danggeun", "forged-affiliate"]) {
    assert.deepEqual(parseAcquisitionLinkRequest!({ jobId: 42, source }), {
      ok: false,
      reason: "invalid_source",
    });
  }
});
