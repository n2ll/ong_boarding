import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
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

  constructor(
    table: string,
    database: Record<string, Row[]>,
    failIdentity: boolean,
  ) {
    this.table = table;
    this.database = database;
    this.failIdentity = failIdentity;
  }

  select() { return this; }
  eq() { return this; }
  neq() { return this; }
  not() { return this; }
  in() { return this; }
  or() { return this; }
  order() { return this; }
  limit() { return this; }

  insert(row: Row) {
    this.action = "insert";
    this.insertedRow = row;
    return this;
  }

  update() {
    this.action = "update";
    return this;
  }

  async single() {
    if (this.table === "job_candidates" && this.action === "select") {
      return { data: this.database.job_candidates[0] ?? null, error: null };
    }
    if (this.table === "messages" && this.action === "insert") {
      return { data: { id: "outbound-1" }, error: null };
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
    const data = this.table === "job_candidates" || this.table === "messages"
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
  }): Promise<{ ok: boolean; reply_sent?: boolean }>;
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

function loadRouter(input: { applicants: Row[]; failIdentity?: boolean }) {
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
    from(table: string) {
      return new QueryBuilder(table, database, input.failIdentity === true);
    },
  };
  const stage = {
    name: "exploration",
    async process() {
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
    "../solapi": {
      sendSms: async (phone: string, body: string) => {
        smsCalls.push({ phone, body });
        return { success: true, messageId: "sms-1" };
      },
    },
    "../jobs": {
      isJobEffectivelyClosed: () => false,
      slotKeysLabel: () => "",
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
        return { next_stage: "exploration", auto_sent_messages: 0 };
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
      getAgentMode: async () => "auto",
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
    setTimeout,
    exports: compiledModule.exports,
    module: compiledModule,
    require: (specifier: string) => stubs[specifier] ?? {},
  });

  return {
    router: compiledModule.exports as RouterModule,
    supabase,
    smsCalls,
    transitions,
  };
}

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
