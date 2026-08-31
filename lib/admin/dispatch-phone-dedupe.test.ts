import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { fetchPhoneMessageIdentityIndex } from "./phone-message-identity.ts";
import { normalizePhone } from "../ongmanaging.ts";
import {
  classifyDispatchSmsCategory,
  smsSendBlockReason,
} from "../sms-consent-policy.ts";

type Row = Record<string, unknown>;

class QueryBuilder {
  private readonly table: string;
  private readonly database: Record<string, Row[]>;
  private equals: Array<[string, unknown]> = [];
  private inValues: Array<[string, unknown[]]> = [];
  private nulls: string[] = [];

  constructor(table: string, database: Record<string, Row[]>) {
    this.table = table;
    this.database = database;
  }

  select() { return this; }
  order() { return this; }
  update() { return this; }
  insert() { return this; }

  eq(column: string, value: unknown) {
    this.equals.push([column, value]);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.inValues.push([column, values]);
    return this;
  }

  is(column: string, value: unknown) {
    if (value === null) this.nulls.push(column);
    return this;
  }

  private rows(): Row[] {
    return (this.database[this.table] ?? []).filter((row) => (
      this.equals.every(([column, value]) => row[column] === value)
      && this.inValues.every(([column, values]) => values.includes(row[column]))
      && this.nulls.every((column) => row[column] == null)
    ));
  }

  async single() {
    return { data: this.rows()[0] ?? null, error: null };
  }

  async range(from: number, to: number) {
    return { data: this.rows().slice(from, to + 1), error: null };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve({ data: this.rows(), error: null }).then(onfulfilled, onrejected);
  }
}

type DispatchResponse = { body: Record<string, unknown>; status: number };
type DispatchRoute = {
  POST: (
    request: { json(): Promise<unknown> },
    context: { params: Promise<{ id: string }> },
  ) => Promise<DispatchResponse>;
};

function loadRoute(input: {
  candidates: Row[];
  applicants: Row[];
  failSmsForApplicantPhone?: string;
  failPhoneIdentityLookup?: boolean;
}) {
  const smsCalls: Array<{ phone: string; body: string }> = [];
  const database: Record<string, Row[]> = {
    jobs: [{
      id: 7,
      body: "#{이름}님, 새 공고입니다. #{맞춤링크}",
      status: "active",
      closes_at: null,
    }],
    job_candidates: input.candidates,
    applicants: input.applicants,
    pool_events: [],
    messages: [],
  };
  const supabase = {
    from(table: string) {
      const query = new QueryBuilder(table, database);
      if (table !== "applicants" || !input.failPhoneIdentityLookup) return query;
      return new Proxy(query, {
        get(target, property, receiver) {
          if (property === "range") {
            return async () => ({
              data: null,
              error: { message: "phone identity unavailable" },
            });
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
  const routePath = new URL(
    "../../app/api/admin/jobs/[id]/dispatch/route.ts",
    import.meta.url,
  );
  const output = ts.transpileModule(readFileSync(routePath, "utf8"), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const compiledModule = { exports: {} as Record<string, unknown> };
  const stubs: Record<string, Record<string, unknown>> = {
    "next/server": {
      NextResponse: {
        json(body: Record<string, unknown>, init?: { status?: number }): DispatchResponse {
          return { body, status: init?.status ?? 200 };
        },
      },
    },
    "@/lib/supabase": { createServiceClient: () => supabase },
    "@/lib/solapi": {
      sendSms: async (phone: string, body: string) => {
        smsCalls.push({ phone, body });
        return normalizePhone(phone) === normalizePhone(input.failSmsForApplicantPhone ?? "")
          ? { success: false, error: "provider rejected" }
          : { success: true, messageId: `sms-${smsCalls.length}` };
      },
    },
    "@/lib/jobs": { isJobEffectivelyClosed: () => false },
    "@/lib/sms-consent-policy": {
      classifyDispatchSmsCategory,
      smsSendBlockReason,
    },
    "@/lib/admin/phone-message-identity": { fetchPhoneMessageIdentityIndex },
    "@/lib/ongmanaging": { normalizePhone },
  };

  runInNewContext(output, {
    Date,
    Map,
    Number,
    Promise,
    Set,
    process,
    console: { error() {} },
    exports: compiledModule.exports,
    module: compiledModule,
    require: (specifier: string) => stubs[specifier] ?? {},
  });

  return {
    route: compiledModule.exports as DispatchRoute,
    smsCalls,
  };
}

function candidate(id: number, applicantId: number): Row {
  return {
    id,
    job_id: 7,
    applicant_id: applicantId,
    sent_at: null,
    agent_state: { meta: { entry: "manual" } },
  };
}

function applicant(id: number, overrides: Row = {}): Row {
  return {
    id,
    name: `지원자${id}`,
    phone: id === 1 ? "010-1234-5678" : "01012345678",
    marketing_consent: true,
    marketing_consent_at: "2026-08-30T00:00:00.000Z",
    sms_opt_out_at: null,
    current_job_id: null,
    access_token: `token-${id}`,
    ...overrides,
  };
}

async function dispatch(route: DispatchRoute): Promise<DispatchResponse> {
  return route.POST(
    { async json() { return {}; } },
    { params: Promise.resolve({ id: "7" }) },
  );
}

test("an ineligible duplicate does not claim the phone before the first eligible candidate", async () => {
  for (const first of [
    applicant(1, { marketing_consent: false, marketing_consent_at: null }),
    applicant(1, {
      sms_opt_out_at: "2026-08-20T00:00:00.000Z",
      marketing_consent: false,
      marketing_consent_at: null,
    }),
  ]) {
    const harness = loadRoute({
      candidates: [candidate(11, 1), candidate(12, 2)],
      applicants: [first, applicant(2)],
    });

    const response = await dispatch(harness.route);

    assert.equal(response.status, 200);
    assert.equal(response.body.sent, 1);
    assert.deepEqual(Array.from(response.body.sent_applicant_ids as number[]), [2]);
    assert.equal(harness.smsCalls.length, 1);
    assert.equal((response.body.skip_reasons as Row).duplicate_phone, 0);
  }
});

test("only the first eligible duplicate reaches the SMS provider", async () => {
  const harness = loadRoute({
    candidates: [candidate(11, 1), candidate(12, 2)],
    applicants: [applicant(1), applicant(2)],
  });

  const response = await dispatch(harness.route);

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 1);
  assert.equal(response.body.skipped, 1);
  assert.deepEqual(Array.from(response.body.sent_applicant_ids as number[]), [1]);
  assert.equal(harness.smsCalls.length, 1);
  assert.equal((response.body.skip_reasons as Row).duplicate_phone, 1);
});

test("a failed first eligible attempt still prevents a sibling retry in the same request", async () => {
  const harness = loadRoute({
    candidates: [candidate(11, 1), candidate(12, 2)],
    applicants: [applicant(1), applicant(2)],
    failSmsForApplicantPhone: "01012345678",
  });

  const response = await dispatch(harness.route);

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.skipped, 2);
  assert.equal(harness.smsCalls.length, 1);
  assert.equal((response.body.skip_reasons as Row).send_fail, 1);
  assert.equal((response.body.skip_reasons as Row).duplicate_phone, 1);
});

test("an active opt-out on a sibling applicant blocks dispatch before the SMS provider", async () => {
  const harness = loadRoute({
    candidates: [candidate(11, 1)],
    applicants: [
      applicant(1),
      applicant(2, {
        marketing_consent: false,
        marketing_consent_at: null,
        sms_opt_out_at: "2026-08-31T00:00:00.000Z",
      }),
    ],
  });

  const response = await dispatch(harness.route);

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.skipped, 1);
  assert.equal((response.body.skip_reasons as Row).opt_out, 1);
  assert.equal(harness.smsCalls.length, 0);
});

test("a phone identity lookup failure stops dispatch before the SMS provider", async () => {
  const harness = loadRoute({
    candidates: [candidate(11, 1)],
    applicants: [applicant(1)],
    failPhoneIdentityLookup: true,
  });

  const response = await dispatch(harness.route);

  assert.equal(response.status, 503);
  assert.match(String(response.body.error), /수신 상태/);
  assert.equal(harness.smsCalls.length, 0);
});

test("a duplicate row bound to another job blocks the shared phone", async () => {
  const harness = loadRoute({
    candidates: [candidate(11, 1)],
    applicants: [
      applicant(1),
      applicant(2, { current_job_id: 9 }),
    ],
  });

  const response = await dispatch(harness.route);

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.skipped, 1);
  assert.deepEqual(Array.from(response.body.conflicts as number[]), [1]);
  assert.equal((response.body.skip_reasons as Row).conflict, 1);
  assert.equal(harness.smsCalls.length, 0);
});
