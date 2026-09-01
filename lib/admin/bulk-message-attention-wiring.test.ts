import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return await readFile(new URL(path, import.meta.url), "utf8");
}

test("the global notification feed isolates a bulk lookup failure and returns the non-PII summary", async () => {
  const route = await source("../../app/api/admin/notifications/route.ts");

  assert.match(route, /loadBulkMessageAttention/);
  assert.match(route, /bulkMessageAttentionPresentation/);
  assert.doesNotMatch(route, /bulkAttention\.state\s*===\s*"error"[\s\S]{0,180}?status:\s*500/);
  assert.match(route, /bulk_message_attention:\s*bulkAttention/);
  assert.match(route, /\.from\("jobs"\)[\s\S]*?\.select\("id, title"\)/);
  assert.match(route, /bulk_message_job_titles:/);
  assert.match(route, /bulkNotice\.state\s*===\s*"error"\s*\?\s*"bulk-message-error"\s*:\s*"bulk-message"/);
});

test("dashboard priority and the pipeline ledger share one bulk attention presentation", async () => {
  const dashboard = await source("../../components/Dashboard.tsx");
  const pipeline = await source("../../components/Pipeline.tsx");

  assert.match(dashboard, /bulkMessageAttentionPresentation\(notiRes\.bulk_message_attention\)/);
  assert.match(dashboard, /id:\s*"bulk-message-attention"/);
  assert.match(dashboard, /cta:\s*"발송 상태 보기"/);
  assert.match(pipeline, /bulkMessageAttentionPresentation\(operationsNotices\.bulk_message_attention\)/);
  assert.match(pipeline, /bulk_attention/);
  assert.match(pipeline, /id="bulk-message-attention"/);
  assert.match(pipeline, /같은 문자는 자동 재발송하지 않습니다/);
  assert.match(pipeline, /id="bulk-message-attention-summary"[\s\S]*?role=\{bulkAttentionUnavailable \? "alert" : "status"\}/);
  assert.doesNotMatch(pipeline, /<section[\s\S]{0,220}?aria-atomic="true"/);
  assert.match(pipeline, /max-h-\[34vh\][^\n]*overflow-y-auto/);
  assert.match(pipeline, /openApplicant\(applicantId, batch\.jobId\)/);
  assert.match(pipeline, /operationsNotices\?\.bulk_message_job_titles/);
  assert.match(pipeline, /발송 상태를 확인하는 중/);
  assert.match(pipeline, /확인이 필요한 발송 건이 없습니다/);
});

test("bulk attention uses a message icon and muted semantic tokens in the top bar", async () => {
  const topbar = await source("../../components/Topbar.tsx");

  assert.match(topbar, /MessageSquareWarning/);
  assert.match(topbar, /n\.kind\s*===\s*"bulk-message"/);
  assert.match(topbar, /bg-priority-attention-soft text-priority-attention-ink/);
  assert.match(topbar, /bg-priority-critical-soft text-priority-critical-ink/);
  assert.match(topbar, /n\.kind\s*===\s*"bulk-message-error"/);
  assert.doesNotMatch(topbar, /n\.tone === "amber" \? "bg-yellow-50/);
});

test("record recovery is presented as pending instead of completed", async () => {
  const pipeline = await source("../../components/Pipeline.tsx");
  const jobs = await source("../../components/Jobs.tsx");

  assert.match(pipeline, /sent > 0\s*\? toast\.success\s*:\s*recordRecoveryCount > 0/);
  assert.match(jobs, /announceSendReport\.recordRecoveryCount > 0[\s\S]*?bg-priority-attention-soft/);
  assert.match(
    jobs,
    /\{\(announceSendReport\.sentCount > 0 \|\| announceSendReport\.alreadySentCount > 0\) && \(/,
  );
  assert.doesNotMatch(
    jobs,
    /announceSendReport\.sentCount > 0 \|\| announceSendReport\.alreadySentCount > 0 \|\| announceSendReport\.recordRecoveryCount/,
  );
});
