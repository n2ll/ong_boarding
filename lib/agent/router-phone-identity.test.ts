import assert from "node:assert/strict";
import { withConversationReplyClaim } from "./conversation-reply-claim.ts";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { readConsultationResult } from "./multi-job-consultation.ts";
import type { StageContext } from "./types";
import { fetchPhoneMessageIdentityIndex } from "../admin/phone-message-identity.ts";
import {
  hasFutureJobPromotion,
  isExplicitSmsOptOutText,
  shouldApplyExplicitSmsOptOut,
} from "../sms-consent-policy.ts";

type Row = Record<string, unknown>;
type Transition = { kind: string; reason?: string };

class QueryBuilder {
  private readonly table: string;
  private readonly database: Record<string, Row[]>;
  private readonly failIdentity: boolean;
  private action: "select" | "insert" | "update" = "select";
  private insertedRow: Row | null = null;
  private after: string | null = null;
  private excludedId: unknown;
  private readonly recordFails: boolean;

  constructor(
    table: string,
    database: Record<string, Row[]>,
    failIdentity: boolean,
    recordFails = false,
  ) {
    this.table = table;
    this.database = database;
    this.failIdentity = failIdentity;
    this.recordFails = recordFails;
  }

  select() { return this; }
  eq() { return this; }
  neq(column?: string, value?: unknown) { if (column === "id") this.excludedId = value; return this; }
  gt(column: string, value: string) { if (column === "created_at") this.after = value; return this; }
  not() { return this; }
  is() { return this; }
  in() { return this; }
  or() { return this; }
  order() { return this; }
  limit() { return this; }

  insert(row: Row) {
    this.action = "insert";
    this.insertedRow = row;
    return this;
  }

  update(row?: Row) {
    this.action = "update";
    this.database._updates = [...(this.database._updates ?? []), { table: this.table, ...row }];
    return this;
  }

  async single() {
    if (this.table === "job_candidates" && this.action === "select") {
      return { data: this.database.job_candidates[0] ?? null, error: null };
    }
    if (this.table === "messages" && this.action === "insert") {
      return this.recordFails ? { data: null, error: { message: "record failed" } } : { data: { id: "outbound-1" }, error: null };
    }
    return { data: null, error: null };
  }

  async range(from: number, to: number) {
    if (this.table === "applicants" && this.failIdentity) {
      return { data: null, error: { message: "identity unavailable" } };
    }
    return {
      data: (this.database[this.table] ?? []).slice(from, to + 1),
      error: null,
    };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    if (this.action === "insert" && this.insertedRow) {
      this.database[this.table] = [
        ...(this.database[this.table] ?? []),
        this.insertedRow,
      ];
    }
    const data = this.table === "messages" && this.after
      ? this.database.messages.filter((row) => String(row.created_at) > this.after! && row.id !== this.excludedId)
      : this.table === "job_candidates" || this.table === "messages"
      ? []
      : (this.database[this.table] ?? []);
    return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
  }
}

type RouterModule = {
  runAgentForCandidate(input: {
    supabase: unknown;
    candidate_id: number;
    inbound_message_id: string;
    inbound_text: string;
    received_at?: string;
  }): Promise<{ ok: boolean; reply_sent?: boolean; skipped?: string; delivery_uncertain?: boolean }>;
};

function applicant(id: number, overrides: Row = {}): Row {
  return {
    id,
    name: "지원자",
    phone: "01012345678",
    birth_date: null,
    location: null,
    own_vehicle: false,
    license_type: null,
    vehicle_type: null,
    branch1: null,
    branch2: null,
    work_hours: null,
    available_slots: null,
    available_date: null,
    self_ownership: null,
    introduction: null,
    experience: null,
    status: "스크리닝 전",
    baemin_id: null,
    marketing_consent: true,
    marketing_consent_at: "2026-08-30T00:00:00.000Z",
    sms_opt_out_at: null,
    ...overrides,
  };
}

function loadRouter(input: { applicants: Row[]; failIdentity?: boolean; mode?: string; stopAfterModel?: boolean; allowedJobs?: number[]; oldSource?: boolean; scoped?: boolean; sendFailure?: "unknown" | "declared"; recordFails?: boolean; transitionUncertain?: boolean; onSleep?: () => void; consultation?: Record<string, unknown>; contextFails?: boolean; observationFails?: boolean }) {
  const observations: unknown[] = [];
  const contexts: StageContext[] = [];
  const rpcCalls: string[] = [];
  const smsCalls: Array<{ phone: string; body: string }> = [];
  const transitions: Transition[] = [];
  const selectedApplicant = input.applicants[0];
  const database: Record<string, Row[]> = {
    applicants: input.applicants,
    messages: [],
    message_drafts: [],
    pool_events: [],
    job_candidates: [{
      id: 11,
      job_id: 7,
      applicant_id: selectedApplicant.id,
      agent_stage: "exploration",
      agent_state: {},
      jobs: {
        id: 7,
        title: "배송 공고",
        body: "공고 본문",
        branch: null,
        slot: null,
        start_date: null,
        vehicle_required: false,
        pickup_address: null,
        site_manager_id: null,
        pay_info: null,
        policy_notes: null,
        pay_type: null,
        pay_amount: null,
        ai_facts: null,
        recruit_mode: "internal",
        status: "active",
        closes_at: null,
        client: null,
      },
      applicants: selectedApplicant,
    }],
  };
  const supabase = {
    rpc: async (name: string) => { rpcCalls.push(name); return { data: name.startsWith("claim_") ? "claimed" : "released", error: null }; },
    from(table: string) {
      return new QueryBuilder(table, database, input.failIdentity === true, input.recordFails);
    },
  };
  const stage = {
    name: "exploration",
    async process(ctx: StageContext) {
      contexts.push(ctx);
      if (input.consultation) return readConsultationResult({ consultation: input.consultation }, ctx, "성수는 월요일 가능하고 강남은 주말 가능해요") ?? {
        reply_text: "잘못된 기존 단계 응답", state_update: {}, transition: { kind: "advance", to: "screening", reason: "wrong" },
      };
      return {
        reply_text: "새로운 일자리 공고가 나왔어요. 확인해보세요.",
        reasoning: "future promotion fixture",
        state_update: {},
        transition: { kind: "stay", reason: "continue" },
      };
    },
  };
  const route = new URL("./router.ts", import.meta.url);
  const output = ts.transpileModule(readFileSync(route, "utf8"), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const compiledModule = { exports: {} as Record<string, unknown> };
  const stubs: Record<string, Record<string, unknown>> = {
    "./conversation-reply-claim": { withConversationReplyClaim },
    "./consultation-context": { loadConsultationJobs: async () => {
      if (input.contextFails) throw new Error("exposure unavailable");
      return input.consultation ? [
        { job_id: 7, title: "성수 공고", branch: "성수", candidate_id: 11, stage: "exploration", expired: false, pay_type: "일당", pay_amount: 70000 },
        { job_id: 8, title: "강남 공고", branch: "강남", candidate_id: null, stage: null, expired: false },
      ] : [{ job_id: 7, title: "배송 공고", candidate_id: 11, stage: "exploration", expired: false }];
    } },
    "./consultation-history": { loadConsultationHistory: async () => ({ history: [], ambiguousFollowup: false, sourceMessages: [{ id: "inbound-1", body: "성수는 월요일 가능하고 강남은 주말 가능해요", created_at: input.oldSource ? "2000-01-01T00:00:00Z" : new Date().toISOString() }] }) },
    "./consultation-observations": { saveConsultationObservations: async (_db: unknown, _id: number, values: unknown[]) => {
      if (input.observationFails) throw new Error("event storage failed");
      observations.push(...values);
    } },
    "../solapi": {
      sendSms: async (phone: string, body: string) => {
        smsCalls.push({ phone, body });
        return input.sendFailure ? { success: false, failureKind: input.sendFailure, error: "provider failed" } : { success: true, messageId: "sms-1" };
      },
    },
    "../jobs": {
      isJobEffectivelyClosed: () => false,
      slotKeysLabel: () => "",
      isSystemJobTitle: () => false,
    },
    "./general-line": {
      isGeneralLineJob: () => false,
      joinedClientType: () => null,
    },
    "../exposure": { ensureExposureIncludeForLinked: async () => {} },
    "./baemin-job": { BAEMIN_SYSTEM_JOB_TITLE: "__baemin_system__" },
    "./system-messages": { getSystemMessage: async () => null },
    "./checklist": { mergeAgentState: (state: Row, patch: Row) => ({ ...state, ...patch }) },
    "./transitions": {
      applyTransition: async ({ transition }: { transition: Transition }) => {
        transitions.push(transition);
        return { next_stage: "exploration", auto_sent_messages: 0, delivery_uncertain: input.transitionUncertain };
      },
    },
    "./cross-job": { crossJobBackstop: () => null },
    "../candidate-links": { isLiveLink: () => true },
    "./stages/exploration": { explorationStage: stage },
    "./stages/screening": { screeningStage: stage },
    "./stages/onboarding": { onboardingStage: stage },
    "./stages/active": { activeStage: stage },
    "./usage": {
      recordUsage: async () => {},
      toMessageTokens: () => ({
        model: null,
        tokens_in: null,
        tokens_out: null,
        cache_read_tokens: null,
      }),
    },
    "./kill-switch": {
      getAgentMode: async (_db: unknown, scope?: { applicantId: number; receivedAt: string; jobIds?: number[] }) => input.allowedJobs && (!scope?.jobIds?.length || scope.jobIds.some((id) => !input.allowedJobs!.includes(id)) || Date.parse(scope.receivedAt) < Date.now() - 3600_000) ? "off" : input.scoped && (!scope || scope.applicantId !== 1 || !scope.receivedAt) ? "off" : input.stopAfterModel && contexts.length ? "off" : input.mode ?? "auto",
      COPILOT_DRAFT_MARKER: "[copilot]",
    },
    "./outbound-safety": { detectAutomatedOutboundSafetyViolation: () => null },
    "../sms-consent-policy": {
      hasFutureJobPromotion,
      isExplicitSmsOptOutText,
      shouldApplyExplicitSmsOptOut,
    },
    "../admin/phone-message-identity": { fetchPhoneMessageIdentityIndex },
  };

  runInNewContext(output, {
    Date,
    Map,
    Number,
    Promise,
    Set,
    process,
    console: { error() {}, warn() {} },
    setTimeout: (callback: () => void) => { input.onSleep?.(); callback(); },
    exports: compiledModule.exports,
    module: compiledModule,
    require: (specifier: string) => stubs[specifier] ?? {},
  });

  return {
    router: compiledModule.exports as RouterModule,
    supabase,
    smsCalls,
    transitions,
    rpcCalls,
    database,
    observations,
    contexts,
  };
}

const consultationEnvelope = { mode: "answer", job_ids: [7, 8], answers: [{ job_id: 7, fields: ["급여"] }], observations: [
  { job_id: 7, source_message_id: "inbound-1", kind: "availability", quote: "성수는 월요일 가능" },
  { job_id: 8, source_message_id: "inbound-1", kind: "availability", quote: "강남은 주말 가능해요" },
] };
test("consultation persists per-job evidence and sends one response without advancing the host", async () => {
  const h = loadRouter({ applicants: [applicant(1)], consultation: consultationEnvelope });
  const result = await run(h.router, h.supabase);
  assert.equal(result.reply_sent, true);
  assert.equal(h.smsCalls.length, 1);
  assert.match(h.smsCalls[0].body, /성수 공고/);
  assert.match(h.smsCalls[0].body, /강남 공고/);
  assert.equal(h.observations.length, 2);
  assert.equal(h.transitions[0].kind, "stay");
  assert.equal(h.database.message_drafts[0].job_id, null);
  assert.equal(h.database._updates?.filter((row) => row.table === "applicants").length ?? 0, 0);
});
test("draft consultation proposes evidence without persisting it or sending SMS", async () => {
  const h = loadRouter({ applicants: [applicant(1)], consultation: consultationEnvelope, mode: "draft" });
  await run(h.router, h.supabase);
  assert.equal(h.smsCalls.length, 0);
  assert.equal(h.observations.length, 0);
  assert.equal(h.transitions.length, 0);
  assert.equal(h.database.message_drafts[0].job_id, null);
  assert.match(String(h.database.message_drafts[0].reasoning), /관찰.*미저장/);
});
test("observation persistence failure stops acknowledgement and hands off visibly", async () => {
  const h = loadRouter({ applicants: [applicant(1)], consultation: consultationEnvelope, observationFails: true });
  await run(h.router, h.supabase);
  assert.equal(h.smsCalls.length, 0);
  assert.equal(h.transitions[0].kind, "pause");
  assert.match(h.transitions[0].reason ?? "", /기록.*실패/);
});
test("missing job facts can send verified known facts before handing off", async () => {
  const h = loadRouter({ applicants: [applicant(1)], consultation: { ...consultationEnvelope, observations: [], answers: [{ job_id: 7, fields: ["급여"] }, { job_id: 8, fields: ["급여"] }] } });
  await run(h.router, h.supabase);
  assert.equal(h.smsCalls.length, 1);
  assert.match(h.smsCalls[0].body, /70,000/);
  assert.equal(h.transitions[0].kind, "pause");
});
test("consultation exposure lookup failure never calls the model or sends SMS", async () => {
  const h = loadRouter({ applicants: [applicant(1)], consultation: consultationEnvelope, contextFails: true });
  await run(h.router, h.supabase);
  assert.equal(h.contexts.length, 0);
  assert.equal(h.smsCalls.length, 0);
  assert.equal(h.transitions[0].kind, "pause");
});
test("invalid consultation in global draft mode remains visible as a need-info card", async () => {
  const h = loadRouter({ applicants: [applicant(1)], consultation: { ...consultationEnvelope, job_ids: [999] }, mode: "draft" });
  await run(h.router, h.supabase);
  assert.equal(h.smsCalls.length, 0);
  assert.equal(h.transitions.length, 0);
  assert.equal(h.database.message_drafts[0]?.status, "need_info");
  assert.match(String(h.database.message_drafts[0]?.missing_info), /상담 검증 실패/);
});

async function run(router: RouterModule, supabase: unknown) {
  return router.runAgentForCandidate({
    supabase,
    candidate_id: 11,
    inbound_message_id: "inbound-1",
    inbound_text: "네",
  });
}

test("future-job promotion pauses when another row for the same phone has an active opt-out", async () => {
  const harness = loadRouter({
    applicants: [
      applicant(1),
      applicant(2, {
        phone: "010-1234-5678",
        marketing_consent: false,
        marketing_consent_at: null,
        sms_opt_out_at: "2026-08-31T00:00:00.000Z",
      }),
    ],
  });

  const result = await run(harness.router, harness.supabase);

  assert.equal(result.ok, true);
  assert.equal(result.reply_sent, false);
  assert.equal(harness.smsCalls.length, 0);
  assert.equal(harness.transitions[0]?.kind, "pause");
  assert.match(harness.transitions[0]?.reason ?? "", /수신거부/);
});

test("future-job promotion pauses when phone identity cannot be verified", async () => {
  const harness = loadRouter({ applicants: [applicant(1)], failIdentity: true });

  const result = await run(harness.router, harness.supabase);

  assert.equal(result.ok, true);
  assert.equal(result.reply_sent, false);
  assert.equal(harness.smsCalls.length, 0);
  assert.equal(harness.transitions[0]?.kind, "pause");
  assert.match(harness.transitions[0]?.reason ?? "", /조회|확인/);
});

test("future-job promotion still sends for the selected consented row without a phone opt-out", async () => {
  const harness = loadRouter({ applicants: [applicant(1)] });

  const result = await run(harness.router, harness.supabase);

  assert.equal(result.ok, true);
  assert.equal(result.reply_sent, true);
  assert.equal(harness.smsCalls.length, 1);
  assert.equal(harness.transitions[0]?.kind, "stay");
});


test("off mode does not take a reply claim", async () => {
  const h = loadRouter({ applicants: [applicant(1)], mode: "off" });
  assert.match((await run(h.router, h.supabase)).skipped ?? "", /kill-switch/);
  assert.deepEqual(h.rpcCalls, []);
});

test("coalescing happens before the claim so the latest handler can answer", async () => {
  const at = new Date(Date.now() - 1_000).toISOString();
  const later = new Date().toISOString();
  let sleeping = 0;
  const h = loadRouter({ applicants: [applicant(1)], onSleep: () => {
    sleeping++;
    assert.equal(h.rpcCalls.length, 0, "sleep must not hold the conversational lock");
    h.database.messages.push({ id: "inbound-2", created_at: later, direction: "inbound" });
  } });
  const first = await h.router.runAgentForCandidate({ supabase: h.supabase, candidate_id: 11, inbound_message_id: "inbound-1", inbound_text: "네", received_at: at });
  assert.match(first.skipped ?? "", /coalesced/);
  assert.equal(sleeping, 1);
  assert.deepEqual(h.rpcCalls, []);
  const second = await h.router.runAgentForCandidate({ supabase: h.supabase, candidate_id: 11, inbound_message_id: "inbound-2", inbound_text: "네 가능합니다", received_at: later });
  assert.equal(second.reply_sent, true);
  assert.equal(h.smsCalls.length, 1);
});

for (const failure of ["unknown", "record", "transition"] as const) {
  test(`${failure} delivery outcome keeps the reply claim for review`, async () => {
    const h = loadRouter({ applicants: [applicant(1)], sendFailure: failure === "unknown" ? "unknown" : undefined,
      recordFails: failure === "record", transitionUncertain: failure === "transition" });
    const result = await run(h.router, h.supabase);
    assert.equal(result.delivery_uncertain, true);
    assert.deepEqual(h.rpcCalls, ["claim_pool_agent_reply"]);
    if (failure !== "transition") assert.equal(h.transitions[0].kind, "pause");
  });
}

test("known provider rejection releases the claim after pausing", async () => {
  const h = loadRouter({ applicants: [applicant(1)], sendFailure: "declared" });
  const result = await run(h.router, h.supabase);
  assert.equal(result.delivery_uncertain ?? false, false);
  assert.equal(h.transitions[0].kind, "pause");
  assert.deepEqual(h.rpcCalls, ["claim_pool_agent_reply", "release_pool_agent_reply"]);
});

test("a stop during model generation prevents response and state writes", async () => {
  const h = loadRouter({ applicants: [applicant(1)], stopAfterModel: true });
  const result = await run(h.router, h.supabase);
  assert.match(result.skipped ?? "", /mode changed/);
  assert.equal(h.smsCalls.length, 0);
  assert.equal(h.transitions.length, 0);
  assert.equal((h.database._updates ?? []).length, 0);
});

test("router supplies verified applicant and inbound timestamp at every scoped mode gate", async () => {
  const h = loadRouter({ applicants: [applicant(1)], scoped: true, consultation: consultationEnvelope });
  const result = await h.router.runAgentForCandidate({ supabase: h.supabase, candidate_id: 11, inbound_message_id: "inbound-1", inbound_text: "네", received_at: new Date(Date.now()-120000).toISOString() });
  assert.equal(result.reply_sent, true);
  assert.equal(h.smsCalls.length, 1);
});

for (const scenario of [{allowedJobs: [7]}, {allowedJobs: [7,8], oldSource: true}]) {
  test(`scoped consultation blocks unrelated jobs or historical unanswered source ${JSON.stringify(scenario)}`, async () => {
    const h = loadRouter({applicants: [applicant(1)], consultation: consultationEnvelope, ...scenario});
    await h.router.runAgentForCandidate({supabase: h.supabase, candidate_id: 11, inbound_message_id: "inbound-1", inbound_text: "두 공고 문의", received_at: new Date(Date.now()-60000).toISOString()});
    assert.equal(h.contexts.length, 0);
    assert.equal(h.smsCalls.length, 0);
    assert.equal(h.transitions.length, 0);
    assert.equal(h.observations.length, 0);
  });
}
test("scoped consultation with every job allowed still responds", async () => {
  const h = loadRouter({applicants: [applicant(1)], consultation: consultationEnvelope, allowedJobs: [7,8]});
  await h.router.runAgentForCandidate({supabase: h.supabase, candidate_id: 11, inbound_message_id: "inbound-1", inbound_text: "두 공고 문의", received_at: new Date(Date.now()-60000).toISOString()});
  assert.equal(h.contexts.length, 1);
  assert.equal(h.smsCalls.length, 1);
});
