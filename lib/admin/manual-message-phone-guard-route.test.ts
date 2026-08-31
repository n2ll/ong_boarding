import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { detectManualOutboundSafetyViolation } from "../agent/outbound-safety.ts";
import { retryManualMessagePostprocess } from "../manual-message-recovery.ts";
import * as manualMessageSend from "../manual-message-send.ts";
import {
  classifyManualSmsCategory,
  smsRecipientBlockReason,
} from "../sms-consent-policy.ts";
import { normalizePhone } from "../ongmanaging.ts";
import { fetchPhoneMessageIdentityIndex } from "./phone-message-identity.ts";

type Row = Record<string, unknown>;
type JsonResponse = { body: Record<string, unknown>; status: number };
type SendRoute = {
  POST: (request: { json(): Promise<unknown> }) => Promise<JsonResponse>;
};

class QueryBuilder {
  private readonly table: string;
  private readonly database: Record<string, Row[]>;
  private readonly failPhoneIdentityLookup: boolean;
  private equals: Array<[string, unknown]> = [];
  private insertedRow: Row | null = null;

  constructor(
    table: string,
    database: Record<string, Row[]>,
    failPhoneIdentityLookup: boolean,
  ) {
    this.table = table;
    this.database = database;
    this.failPhoneIdentityLookup = failPhoneIdentityLookup;
  }

  select() { return this; }
  order() { return this; }
  limit() { return this; }
  update() { return this; }

  insert(row: Row) {
    this.insertedRow = row;
    return this;
  }

  eq(column: string, value: unknown) {
    this.equals.push([column, value]);
    return this;
  }

  in() { return this; }

  private rows(): Row[] {
    return (this.database[this.table] ?? []).filter((row) => (
      this.equals.every(([column, value]) => row[column] === value)
    ));
  }

  async single() {
    if (this.insertedRow) return { data: this.insertedRow, error: null };
    return { data: this.rows()[0] ?? null, error: null };
  }

  async maybeSingle() {
    return { data: this.rows()[0] ?? null, error: null };
  }

  async range(from: number, to: number) {
    if (this.table === "applicants" && this.failPhoneIdentityLookup) {
      return {
        data: null,
        error: { message: "phone identity unavailable" },
      };
    }
    return { data: this.rows().slice(from, to + 1), error: null };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve({ data: this.rows(), error: null }).then(onfulfilled, onrejected);
  }
}

function applicant(id: number, overrides: Row = {}): Row {
  return {
    id,
    phone: id === 1 ? "010-1234-5678" : "01012345678",
    marketing_consent: true,
    marketing_consent_at: "2026-08-20T00:00:00.000Z",
    sms_opt_out_at: null,
    ...overrides,
  };
}

function loadRoute(input: {
  applicants: Row[];
  failPhoneIdentityLookup?: boolean;
}) {
  const smsCalls: Array<{ phone: string; body: string }> = [];
  const database: Record<string, Row[]> = {
    applicants: input.applicants,
    manual_message_send_requests: [],
  };
  const supabase = {
    from(table: string) {
      return new QueryBuilder(
        table,
        database,
        input.failPhoneIdentityLookup === true,
      );
    },
    async rpc() {
      return { data: "failed", error: null };
    },
  };
  const routePath = new URL(
    "../../app/api/admin/messages/send/route.ts",
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
        json(body: Record<string, unknown>, init?: { status?: number }): JsonResponse {
          return { body, status: init?.status ?? 200 };
        },
      },
    },
    "@/lib/supabase": { createServiceClient: () => supabase },
    "@/lib/solapi": {
      sendSms: async (phone: string, body: string) => {
        smsCalls.push({ phone, body });
        return { success: true, messageId: "sms-1" };
      },
    },
    "@/lib/agent/outbound-safety": { detectManualOutboundSafetyViolation },
    "@/lib/sms-consent-policy": {
      classifyManualSmsCategory,
      smsRecipientBlockReason,
    },
    "@/lib/manual-message-send": manualMessageSend,
    "@/lib/manual-message-recovery": { retryManualMessagePostprocess },
    "@/lib/admin/phone-message-identity": { fetchPhoneMessageIdentityIndex },
    "@/lib/ongmanaging": { normalizePhone },
  };

  runInNewContext(output, {
    Date,
    Map,
    Number,
    Promise,
    process,
    console: { error() {} },
    exports: compiledModule.exports,
    module: compiledModule,
    require: (specifier: string) => stubs[specifier] ?? {},
  });

  return {
    route: compiledModule.exports as SendRoute,
    smsCalls,
  };
}

function request() {
  return {
    async json() {
      return {
        applicant_id: 1,
        phone: "01012345678",
        body: "안녕하세요. 현재 지원 건을 안내드립니다.",
        sent_by: "관리자",
        purpose: "current_application",
        idempotency_key: "11111111-1111-4111-8111-111111111111",
      };
    },
  };
}

test("manual send returns 409 when a sibling applicant has an active phone opt-out", async () => {
  const harness = loadRoute({
    applicants: [
      applicant(1),
      applicant(2, {
        marketing_consent: false,
        marketing_consent_at: null,
        sms_opt_out_at: "2026-08-25T00:00:00.000Z",
      }),
    ],
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 409);
  assert.equal(response.body.code, "marketing_consent_required");
  assert.equal(response.body.delivery, "failed");
  assert.equal(response.body.retryable, false);
  assert.match(String(response.body.error), /수신거부/);
  assert.equal(harness.smsCalls.length, 0);
});

test("manual send returns 503 when phone identity lookup fails", async () => {
  const harness = loadRoute({
    applicants: [applicant(1)],
    failPhoneIdentityLookup: true,
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 503);
  assert.equal(response.body.code, "recipient_unavailable");
  assert.equal(response.body.delivery, "failed");
  assert.match(String(response.body.error), /수신 상태/);
  assert.equal(harness.smsCalls.length, 0);
});
