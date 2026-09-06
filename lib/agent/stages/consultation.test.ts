import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { Stage, StageContext, StageResult } from "../types";

const stageDirectory = dirname(fileURLToPath(import.meta.url));
const usage = { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 67 };
const inbound = "새벽 배송과 낮 배송 시간 알려주세요. 새벽 배송은 관심 있어요. 제 아이디는 kim123입니다.";

function context(): StageContext {
  return {
    job: {
      id: 10, title: "새벽 배송", body: "새벽 배송 안내", branch: "강남", slot: "04:00~08:00",
      start_date: null, vehicle_required: true, pickup_address: null, site_manager_id: null,
      client_type: "baemin_bmart",
    },
    applicant: {
      id: 1, name: "지원자", phone: "01000000000", birth_date: null, location: null,
      own_vehicle: null, license_type: null, vehicle_type: null, branch1: null, branch2: null,
      work_hours: null, available_slots: null, available_date: null, self_ownership: null,
      introduction: null, experience: null, status: null, baemin_id: null,
      marketing_consent: null, marketing_consent_at: null, sms_opt_out_at: null,
    },
    history: [],
    state: { screening: { 자차_재확인: false }, onboarding: { 배민_아이디_수신: false } },
    consultation: {
      jobs: [
        { job_id: 10, candidate_id: 100, title: "새벽 배송", branch: "강남", slot: "04:00~08:00", stage: "screening", expired: false },
        { job_id: 20, candidate_id: null, title: "낮 배송", branch: "강북", slot: "13:00~17:00", stage: null, expired: false },
      ],
      sourceMessages: [{ id: "inbound-1", body: inbound, created_at: "2026-09-06T00:00:00Z" }],
      force: false,
      ambiguousFollowup: false,
    },
  };
}

function answer() {
  return {
    mode: "answer", job_ids: [10, 20],
    answers: [{ job_id: 10, fields: ["근무시간"] }, { job_id: 20, fields: ["근무시간"] }],
    observations: [{ job_id: 10, source_message_id: "inbound-1", kind: "interest", quote: "새벽 배송은 관심 있어요." }],
  };
}

function advancingOutput(consultation: unknown): Record<string, unknown> {
  return {
    reply_text: "임의 답변은 발송하면 안 됩니다.", transition: "advance", transition_reason: "진행",
    intent_signal: "ready_to_apply", reasoning: "진행", baemin_id_text: "kim123",
    checklist_update: {
      자차_재확인: true, 프로모션_종료가능성_안내: true, 정산주기_안내: true,
      공휴일_업무여부_확인: true, 본인명의_정산_문제없음: true,
      업무시간_체계_이해: true, 지원자_질문_해소: true, 배민_아이디_수신: true,
    },
    collected: { 차종: "승용차", 시작가능일: "내일", 선탑_가능시간: "오전" },
    marketing_consent: true, consultation,
  };
}

type RequestBody = {
  tools: Array<{ input_schema: { required: string[] } }>;
  tool_choice: { name: string };
  messages: Array<{ content: string }>;
};

// Execute the production modules and mock only network I/O and DB-backed prompt examples.
function harness(stageName: string, output: Record<string, unknown> | null, failure?: "http" | "parse") {
  const requests: Array<{ url: string; body: RequestBody }> = [];
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  function load(filename: string): Record<string, unknown> {
    const absolute = filename.endsWith(".ts") ? filename : `${filename}.ts`;
    if (absolute === resolve(stageDirectory, "../examples.ts")) {
      return {
        buildToneGuide: async () => "", loadLineKnowledge: async () => "",
        loadConversationExamples: async () => "", loadPersonaGuidance: async () => "",
      };
    }
    const cached = cache.get(absolute);
    if (cached) return cached.exports;
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), {
      compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const compiledModule = { exports: {} };
    cache.set(absolute, compiledModule);
    runInNewContext(compiled, {
      module: compiledModule, exports: compiledModule.exports, Date, Intl, console, URL,
      process: { env: { CLAUDE_API: "test-key", SLACK_NOTIFICATIONS_ENABLED: "1", SLACK_WEBHOOK_URL: "https://slack.test/hook" } },
      require(specifier: string) {
        assert.ok(specifier.startsWith("."), `Unexpected dependency: ${specifier}`);
        return load(resolve(dirname(absolute), specifier));
      },
      async fetch(url: string, options: { body: string }) {
        const body = JSON.parse(options.body) as RequestBody;
        requests.push({ url, body });
        return {
          ok: failure !== "http",
          status: failure === "http" ? 503 : 200,
          json: async () => {
            if (failure === "parse") throw new SyntaxError("Invalid JSON");
            return { content: output ? [{ type: "tool_use", name: body.tool_choice?.name, input: output }] : [], usage };
          },
        };
      },
    });
    return compiledModule.exports;
  }
  return {
    requests,
    stage: load(resolve(stageDirectory, stageName))[`${stageName}Stage`] as Stage,
  };
}

function assertNoProgress(result: StageResult, before: StageContext, after: StageContext) {
  assert.equal(result.applicant_patch, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(after)), before, "the incoming state must remain unchanged");
  if (result.state_update.screening) assert.deepEqual(JSON.parse(JSON.stringify(result.state_update.screening)), before.state.screening);
  if (result.state_update.onboarding) assert.deepEqual(JSON.parse(JSON.stringify(result.state_update.onboarding)), before.state.onboarding);
  assert.equal(result.state_update.meta?.general_screening, undefined);
}

for (const stageName of ["exploration", "screening", "onboarding", "active"]) {
  test(`${stageName}: consultation cannot advance, update checklists, or patch applicant fields`, async () => {
    const ctx = context();
    const before = structuredClone(ctx);
    const { stage, requests } = harness(stageName, advancingOutput(answer()));
    const result = await stage.process(ctx, inbound);

    assert.ok(result.consultation, "must return the server-validated consultation result");
    assert.equal(result.transition.kind, "stay");
    assertNoProgress(result, before, ctx);
    assert.match(result.reply_text ?? "", /새벽 배송/);
    assert.match(result.reply_text ?? "", /낮 배송/);
    assert.match(result.reply_text ?? "", /04:00~08:00/);
    assert.match(result.reply_text ?? "", /13:00~17:00/);
    assert.doesNotMatch(result.reply_text ?? "", /임의 답변/);
    assert.equal(result.consultation.observations[0]?.quote, "새벽 배송은 관심 있어요.");
    assert.deepEqual(JSON.parse(JSON.stringify(result.usage)), { model: "claude-sonnet-4-6", ...usage });
    assert.equal(requests.length, 1, "a consultation needs one Claude request and no Slack request");
    assert.equal(requests[0].url, "https://api.anthropic.com/v1/messages");
    assert.ok(requests[0].body.tools[0].input_schema.required.includes("consultation"));
    assert.match(requests[0].body.messages[0].content, /낮 배송/);
    assert.match(requests[0].body.messages[0].content, /inbound-1/);
  });

  test(`${stageName}: invalid consultation pauses before normal processing and retains usage`, async () => {
    const ctx = context();
    const before = structuredClone(ctx);
    const { stage, requests } = harness(stageName, advancingOutput({ ...answer(), job_ids: [999] }));
    const result = await stage.process(ctx, inbound);
    assert.equal(result.transition.kind, "pause");
    assert.equal(result.reply_text, null);
    assertNoProgress(result, before, ctx);
    assert.deepEqual(JSON.parse(JSON.stringify(result.usage)), { model: "claude-sonnet-4-6", ...usage });
    assert.equal(requests.length, 1);
  });

  test(`${stageName}: missing tool output retains billed usage and cannot progress`, async () => {
    const ctx = context();
    const before = structuredClone(ctx);
    const { stage, requests } = harness(stageName, null);
    const result = await stage.process(ctx, inbound);
    assert.equal(result.transition.kind, "pause");
    assert.equal(result.reply_text, null);
    assertNoProgress(result, before, ctx);
    assert.deepEqual(JSON.parse(JSON.stringify(result.usage)), { model: "claude-sonnet-4-6", ...usage });
    assert.equal(requests.length, 1);
  });
}

test("general screening: consultation bypasses collected profile and marketing-consent processing", async () => {
  const ctx = context();
  ctx.job!.client_type = "general";
  ctx.jobClosed = true;
  const before = structuredClone(ctx);
  const { stage } = harness("screening", advancingOutput(answer()));
  const result = await stage.process(ctx, inbound);
  assert.ok(result.consultation);
  assert.equal(result.transition.kind, "stay");
  assertNoProgress(result, before, ctx);
});

test("active: ambiguous acknowledgement after multiple jobs asks for its target instead of going silent", async () => {
  const ctx = context();
  ctx.history = [{ direction: "outbound", body: "새벽 배송과 낮 배송을 확인 후 안내드릴게요.", created_at: "2026-09-05T23:59:00Z" }];
  ctx.consultation!.ambiguousFollowup = true;
  ctx.consultation!.sourceMessages[0].body = "네";
  const { stage, requests } = harness("active", advancingOutput({
    mode: "clarify", job_ids: [10, 20], answers: [], observations: [], reason: "관심 공고 확인",
  }));
  const result = await stage.process(ctx, "네");
  assert.equal(result.consultation?.clarification, true);
  assert.ok(result.reply_text);
  assert.equal(requests.length, 1);
});

test("active: an ambiguous acknowledgement still gets clarification when only one job remains visible", async () => {
  const ctx = context();
  ctx.consultation!.jobs = [ctx.consultation!.jobs[0]];
  ctx.consultation!.ambiguousFollowup = true;
  ctx.consultation!.sourceMessages[0].body = "네";
  ctx.history = [{ direction: "outbound", body: "새벽 배송과 낮 배송을 확인 후 안내드릴게요.", created_at: "2026-09-05T23:59:00Z" }];
  const { stage, requests } = harness("active", advancingOutput({ mode: "clarify", job_ids: [10], answers: [], observations: [] }));
  const result = await stage.process(ctx, "네");
  assert.equal(result.consultation?.clarification, true);
  assert.ok(result.reply_text);
  assert.equal(requests.length, 1);
});

test("active: ordinary closing acknowledgement still skips the model", async () => {
  const ctx = context();
  delete ctx.consultation;
  ctx.history = [{ direction: "outbound", body: "확인 후 안내드릴게요.", created_at: "2026-09-05T23:59:00Z" }];
  const { stage, requests } = harness("active", {});
  const result = await stage.process(ctx, "네");
  assert.equal(result.reply_text, null);
  assert.equal(result.transition.kind, "stay");
  assert.equal(requests.length, 0);
});

test("active: ordinary conversation preserves its draft response path", async () => {
  const ctx = context();
  delete ctx.consultation;
  const { stage, requests } = harness("active", { status: "reply", draft_text: "매니저가 확인 후 안내드립니다.", reasoning: "일반 문의" });
  const result = await stage.process(ctx, "매니저 연락은 언제 오나요?");
  assert.equal(result.reply_text, "매니저가 확인 후 안내드립니다.");
  assert.equal(result.transition.kind, "stay");
  assert.equal(requests[0].body.tool_choice.name, "draft_reply");
  assert.equal(requests.length, 1);
});

for (const failure of [undefined, "http", "parse"] as const) {
  test(`active: consultation failure preserves the full saved state (${failure ?? "missing tool"})`, async () => {
    const ctx = context();
    const { stage, requests } = harness("active", null, failure);
    const result = await stage.process(ctx, inbound);
    assert.equal(result.transition.kind, "pause");
    assert.equal(result.reply_text, null);
    assert.deepEqual(JSON.parse(JSON.stringify(result.state_update)), ctx.state);
    assert.equal(requests.length, 1);
  });
}

test("exploration: explicit current-job progress remains available with multiple consultation jobs", async () => {
  const ctx = context();
  ctx.consultation!.sourceMessages[0].body = "새벽 배송에 지원할게요.";
  const { stage, requests } = harness("exploration", advancingOutput({
    mode: "current", job_ids: [10], answers: [], observations: [],
  }));
  const result = await stage.process(ctx, "새벽 배송에 지원할게요.");
  assert.equal(result.transition.kind, "advance");
  assert.equal(result.consultation, undefined);
  assert.equal(requests.length, 1);
});

test("exploration: a single unforced job preserves the original tool contract", async () => {
  const ctx = context();
  ctx.consultation!.sourceMessages[0].body = "새벽 배송에 지원할게요.";
  ctx.consultation!.jobs = [ctx.consultation!.jobs[0]];
  const { stage, requests } = harness("exploration", advancingOutput(undefined));
  const result = await stage.process(ctx, "새벽 배송에 지원할게요.");
  assert.equal(result.transition.kind, "advance");
  assert.equal(result.consultation, undefined);
  assert.ok(!requests[0].body.tools[0].input_schema.required.includes("consultation"));
});
