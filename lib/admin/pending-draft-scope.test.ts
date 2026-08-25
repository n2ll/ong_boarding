import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface DraftRow {
  id: string;
  draft_text: string | null;
  job_id: number | null;
}

type PendingDraftScopeModule = {
  shouldLoadCandidateAgentState?: (
    requestedJobId: number | null,
    draftScope?: "all" | "unscoped",
  ) => boolean;
  pendingDraftMatchesScope?: (
    draftJobId: number | null,
    requestedJobId: number | null,
    draftScope?: "all" | "unscoped",
  ) => boolean;
  selectPendingDraftForJob?: (
    orderedDrafts: DraftRow[],
    requestedJobId: number | null,
  ) => DraftRow | null;
};

async function loadModule(): Promise<PendingDraftScopeModule> {
  try {
    return await import(new URL("./pending-draft-scope.ts", import.meta.url).href) as PendingDraftScopeModule;
  } catch {
    return {};
  }
}

const drafts: DraftRow[] = [
  { id: "new-other-job", draft_text: "다른 공고 최신 초안", job_id: 22 },
  { id: "current-job", draft_text: "현재 공고 초안", job_id: 11 },
  { id: "unscoped", draft_text: "공고 불명 초안", job_id: null },
];

test("a job tab selects its newest matching draft instead of a newer draft from another job", async () => {
  const { selectPendingDraftForJob } = await loadModule();

  assert.equal(typeof selectPendingDraftForJob, "function");
  assert.deepEqual(
    selectPendingDraftForJob!(drafts, 11),
    drafts[1],
  );
});

test("a job tab never binds a draft whose inbound job is missing or unknown", async () => {
  const { selectPendingDraftForJob } = await loadModule();

  assert.equal(typeof selectPendingDraftForJob, "function");
  assert.equal(selectPendingDraftForJob!(drafts, 33), null);
  assert.equal(
    selectPendingDraftForJob!([
      { id: "missing-message", draft_text: "출처 없음", job_id: null },
      drafts[2],
    ], 11),
    null,
  );
});

test("the all-jobs view keeps the latest draft and returns its derived job", async () => {
  const { selectPendingDraftForJob } = await loadModule();

  assert.equal(typeof selectPendingDraftForJob, "function");
  assert.deepEqual(
    selectPendingDraftForJob!(drafts, null),
    drafts[0],
  );
});

test("an explicit unscoped view rejects job-bound drafts while the all view keeps them", async () => {
  const { pendingDraftMatchesScope } = await loadModule();

  assert.equal(typeof pendingDraftMatchesScope, "function");
  assert.equal(pendingDraftMatchesScope!(22, null, "unscoped"), false);
  assert.equal(pendingDraftMatchesScope!(null, null, "unscoped"), true);
  assert.equal(pendingDraftMatchesScope!(22, null, "all"), true);
  assert.equal(pendingDraftMatchesScope!(22, 11, "all"), false);
  assert.equal(pendingDraftMatchesScope!(11, 11, "all"), true);
});

test("an explicit unscoped view never inherits AI state from an arbitrary job", async () => {
  const { shouldLoadCandidateAgentState } = await loadModule();

  assert.equal(typeof shouldLoadCandidateAgentState, "function");
  assert.equal(shouldLoadCandidateAgentState!(null, "unscoped"), false);
  assert.equal(shouldLoadCandidateAgentState!(null, "all"), true);
  assert.equal(shouldLoadCandidateAgentState!(11, "all"), true);
});

test("ignoring a draft requires the same applicant, job, and unresolved status", async () => {
  const route = await readFile(
    new URL("../../app/api/admin/drafts/[id]/route.ts", import.meta.url),
    "utf8",
  );
  const thread = await readFile(
    new URL("../../components/ConversationThread.tsx", import.meta.url),
    "utf8",
  );

  assert.match(route, /applicant_id/);
  assert.match(route, /job_id/);
  assert.match(route, /\.eq\("applicant_id",\s*applicantId\)/);
  assert.match(route, /\.is\("send_claim_key",\s*null\)/);
  assert.match(route, /\.in\("status",\s*\["pending",\s*"need_info"\]\)/);
  assert.match(thread, /action:\s*"ignored"[\s\S]*?applicant_id:\s*applicantId[\s\S]*?job_id:/);
});

test("the live queue carries a pending draft job into the opened conversation", async () => {
  const preview = await readFile(
    new URL("../message-preview.ts", import.meta.url),
    "utf8",
  );
  const live = await readFile(
    new URL("../../components/LiveConsole.tsx", import.meta.url),
    "utf8",
  );

  assert.match(preview, /pending_draft_job_id/);
  assert.match(preview, /select\("id, applicant_id, job_id, created_at"\)/);
  assert.match(preview, /\.order\("created_at",\s*\{\s*ascending:\s*false\s*\}\)/);
  assert.match(live, /pending_draft_job_id/);
  assert.match(live, /focusJobIdRef\.current\s*=\s*draftJobId/);
  assert.match(live, /focusUnscopedDraftRef/);
  assert.match(live, /공고 미지정 초안/);
});

test("the pending-draft endpoint limits an explicit unscoped request to job_id NULL", async () => {
  const route = await readFile(
    new URL("../../app/api/admin/drafts/pending/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /searchParams\.get\("draft_scope"\)/);
  assert.match(
    route,
    /draftScope\w*\s*===\s*"unscoped"[\s\S]*?pendingDraftQuery\s*=\s*pendingDraftQuery\.is\("job_id",\s*null\)/,
  );
});

test("the message endpoint limits an explicit unscoped draft request to job_id NULL", async () => {
  const route = await readFile(
    new URL("../../app/api/admin/messages/[applicantId]/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /searchParams\.get\("draft_scope"\)/);
  assert.match(
    route,
    /draftScope\w*\s*===\s*"unscoped"[\s\S]*?pendingDraftQuery\s*=\s*pendingDraftQuery\.is\("job_id",\s*null\)/,
  );
  assert.match(route, /shouldLoadCandidateAgentState\(jobIdFilter,\s*draftScope/);
});

test("the unscoped live tab passes an explicit draft scope into the conversation", async () => {
  const [live, thread] = await Promise.all([
    readFile(new URL("../../components/LiveConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/ConversationThread.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(thread, /draftScope\?:\s*"all"\s*\|\s*"unscoped"/);
  assert.match(live, /currentSelectedJobId\s*===\s*null[\s\S]*?pending_draft_job_id\s*===\s*null[\s\S]*?"unscoped"/);
  assert.match(live, /<ConversationThread[\s\S]*?draftScope=\{/);
  assert.match(thread, /agentPresentation\.kind\s*===\s*"unscoped"[\s\S]*?role="status"[\s\S]*?agentPresentation\.notice/);
});

test("the unscoped draft context hides unrelated job state and direct-send controls", async () => {
  const [live, thread] = await Promise.all([
    readFile(new URL("../../components/LiveConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/ConversationThread.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(live, /const\s+isUnscopedDraftContext\s*=[\s\S]*?pending_draft_job_id\s*===\s*null/);
  assert.match(live, /!isUnscopedDraftContext\s*&&\s*activeChat\.agent_stage\s*&&\s*<StageBadge/);
  assert.match(
    thread,
    /agentPresentation\.kind\s*===\s*"unscoped"\s*\?\s*\([\s\S]*?초안 카드[\s\S]*?\)\s*:\s*canSend\s*\?/,
  );
});

test("a late unscoped ignore response cannot clear or leave a newer thread scope", async () => {
  const thread = await readFile(
    new URL("../../components/ConversationThread.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    thread,
    /const handleIgnoreDraft[\s\S]*?const\s+(\w+)\s*=\s*threadScopeKey;[\s\S]*?const\s+(\w+)\s*=\s*(?:threadScopeRevision|threadScopeIdentityRef\.current\.revision);[\s\S]*?await fetch[\s\S]*?if\s*\(\s*!isCurrentThreadScope\(\1,\s*\2\)\s*\)\s*return;[\s\S]*?setDraftComposer[\s\S]*?setPendingDraft[\s\S]*?onUnscopedDraftResolved/,
  );
});
