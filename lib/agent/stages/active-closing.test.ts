import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { shouldSuppressConversationReply } from "../conversation-closing.ts";
import type { Stage, StageContext } from "../types";

async function process(inbound: string, outbound: string) {
  let calls = 0;
  const exports: { activeStage?: Stage } = {};
  const source = readFileSync(new URL("./active.ts", import.meta.url), "utf8");
  const stubs: Record<string, unknown> = {
    "../../agent": { generateDraftReply: async () => { calls++; return { status: "reply", draft_text: "답변을 확인했습니다.", reasoning: "fixture" }; } },
    "./consultation": {}, "../conversation-closing": { shouldSuppressConversationReply },
  };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (name: string) => stubs[name], Date });
  const ctx = { applicant: {}, state: {}, job: null, history: [{ direction: "outbound", body: outbound, created_at: "2026-09-09T00:00:00Z" }] } as StageContext;
  const result = await exports.activeStage!.process(ctx, inbound);
  return { calls, result };
}
test("active does not discard an answer just because its preceding question also promised follow-up", async () => {
  const h = await process("네", "일정은 매니저가 안내드릴게요. 22일 가능하세요?");
  assert.equal(h.calls, 1);
  assert.equal(h.result.reply_text, "답변을 확인했습니다.");
});
test("active still skips a redundant acknowledgement after a final notice", async () => {
  const h = await process("감사합니다", "일정은 매니저가 안내드릴게요.");
  assert.equal(h.calls, 0);
  assert.equal(h.result.reply_text, null);
});
