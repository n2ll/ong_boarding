import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as checklist from "./checklist.ts";
import * as generalLine from "./general-line.ts";
import * as outboundSafety from "./outbound-safety.ts";
import { fillTemplate } from "./system-messages.ts";
import type { AgentState, JobContext, StageName } from "./types";

type Row = Record<string, unknown>;
type Failure = "unknown" | "provider-throw" | "record-error" | "record-throw" | "declared" | "template-throw";
type Path = "screening" | "handoff" | "guide";
type Write = { table: string; action: "insert" | "update"; row: Row };
type QueryResult = { data: Row[]; error: { message: string } | null };

const compiled = ts.transpileModule(
  readFileSync(new URL("./transitions.ts", import.meta.url), "utf8"),
  { compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function harness(failure?: Failure) {
  const writes: Write[] = [];
  const sends: string[] = [];
  const alerts: Row[] = [];

  class Query {
    private action: "select" | "insert" | "update" = "select";
    private row: Row = {};
    private table: string;
    constructor(table: string) { this.table = table; }
    select() { return this; }
    eq() { return this; }
    neq() { return this; }
    in() { return this; }
    order() { return this; }
    limit() { return this; }
    insert(row: Row) { this.action = "insert"; this.row = row; return this; }
    update(row: Row) { this.action = "update"; this.row = row; return this; }
    then<TResult1 = QueryResult, TResult2 = never>(
      onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      const execute = async (): Promise<QueryResult> => {
        if (this.action !== "select") writes.push({ table: this.table, action: this.action, row: this.row });
        if (this.table === "messages" && this.action === "insert") {
          if (failure === "record-throw") throw new Error("record connection lost");
          if (failure === "record-error") return { data: [], error: { message: "record failed" } };
        }
        return { data: [], error: null };
      };
      return execute().then(onfulfilled, onrejected);
    }
  }

  const modules: Record<string, unknown> = {
    "../solapi": {
      async sendNotification(_phone: string, template: string) {
        sends.push(template);
        if (failure === "provider-throw") throw new Error("provider connection lost");
        if (failure === "unknown" || failure === "declared") {
          return { success: false, failureKind: failure, error: "provider failed", via: "sms" };
        }
        return { success: true, messageId: "fake-sms-1", via: "sms" };
      },
    },
    "../slack": { async sendSlackPausedAlert(alert: Row) { alerts.push(alert); } },
    "./system-messages": {
      fillTemplate,
      async getSystemMessage() {
        if (failure === "template-throw") throw new Error("template unavailable");
        return null;
      },
    },
    "./baemin-job": { BAEMIN_SYSTEM_JOB_TITLE: "__baemin_system__" },
    "./checklist": checklist,
    "./general-line": generalLine,
    "./outbound-safety": outboundSafety,
  };
  const compiledModule = { exports: {} };
  runInNewContext(compiled, {
    Date, Error, Intl, console: { error() {} },
    exports: compiledModule.exports,
    module: compiledModule,
    require(specifier: string) {
      assert.ok(Object.hasOwn(modules, specifier), `Unexpected dependency: ${specifier}`);
      return modules[specifier];
    },
  });
  const transitions = compiledModule.exports as {
    applyTransition(input: {
      supabase: unknown;
      candidate_id: number;
      applicant_id: number;
      applicant_name: string;
      applicant_phone: string;
      job_id: number;
      job: Pick<JobContext, "title" | "client_type">;
      current_stage: StageName;
      state_update: AgentState;
      transition: { kind: "advance"; to: StageName };
    }): Promise<{ next_stage: StageName; auto_sent_messages: number; delivery_uncertain?: boolean }>;
  };

  return {
    writes, sends, alerts,
    run(path: Path) {
      return transitions.applyTransition({
        supabase: { from: (table: string) => new Query(table) },
        candidate_id: 10, applicant_id: 20, applicant_name: "테스트 지원자",
        applicant_phone: "01000000000", job_id: 30,
        job: { title: "테스트 배송", client_type: path === "handoff" ? "general" : "baemin_bmart" },
        current_stage: path === "screening" ? "exploration" : "screening",
        state_update: {},
        transition: { kind: "advance", to: path === "screening" ? "screening" : "onboarding" },
      });
    },
  };
}

function savedState(writes: Write[]): AgentState {
  const saved = writes.findLast((write) => write.table === "job_candidates" && write.row.agent_state);
  assert.ok(saved, "transition must save its paused state");
  return saved.row.agent_state as AgentState;
}

const templates: Record<Path, string> = {
  screening: "SCREENING_ANNOUNCE",
  handoff: "GENERAL_SCREENING_HANDOFF",
  guide: "GUIDE",
};

for (const path of ["screening", "handoff", "guide"] as const) {
  for (const failure of ["unknown", "provider-throw", "record-error", "record-throw", "declared"] as const) {
    test(`${path}: ${failure} pauses without progress and preserves delivery uncertainty`, async () => {
      const fixture = harness(failure);
      const result = await fixture.run(path);

      assert.equal(result.delivery_uncertain, failure === "declared" ? undefined : true);
      assert.equal(result.next_stage, "paused");
      assert.equal(result.auto_sent_messages, 0);
      assert.deepEqual(fixture.sends, [templates[path]]);
      assert.equal(fixture.writes.some((write) => write.table === "applicants"), false,
        "failed delivery recording must not set status or guide_sent");
      assert.equal(fixture.writes.some((write) => Object.hasOwn(write.row, "screening_passed_at")), false);
      const state = savedState(fixture.writes);
      assert.equal(Object.values(state.screening ?? {}).some(Boolean), false);
      assert.equal(Object.values(state.onboarding ?? {}).some(Boolean), false);
      assert.equal(state.meta?.pause?.category, "tech");
      assert.equal(fixture.alerts.length, 1);
    });
  }

  test(`${path}: recorded success still advances and is not uncertain`, async () => {
    const fixture = harness();
    const result = await fixture.run(path);

    assert.equal(result.delivery_uncertain, undefined);
    assert.equal(result.auto_sent_messages, 1);
    assert.equal(result.next_stage, path === "handoff" ? "paused" : path === "guide" ? "onboarding" : "screening");
    assert.deepEqual(fixture.sends, [templates[path]]);
    assert.ok(fixture.writes.some((write) => write.table === "applicants" && write.row.status));
    const state = savedState(fixture.writes);
    if (path === "screening") assert.equal(state.screening?.정산주기_안내, true);
    if (path === "handoff") assert.equal(state.meta?.pause?.category, "call");
    if (path === "guide") {
      assert.equal(state.onboarding?.앱설치_교육_안내발송됨, true);
      assert.ok(fixture.writes.some((write) => write.table === "applicants" && write.row.guide_sent === true));
    }
  });
}

test("failure before attempting a provider send is not delivery uncertainty", async () => {
  const fixture = harness("template-throw");
  const result = await fixture.run("screening");
  assert.equal(result.delivery_uncertain, undefined);
  assert.equal(result.next_stage, "paused");
  assert.deepEqual(fixture.sends, []);
});
