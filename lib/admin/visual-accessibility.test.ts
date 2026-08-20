import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceFrom = (path: string) =>
  readFile(new URL(path, import.meta.url), "utf8");

test("dense manager surfaces keep visible operational text at 12px or larger", async () => {
  const files = [
    "../../components/ConversationThread.tsx",
    "../../components/AgentBrain.tsx",
    "../../components/Automation.tsx",
  ];

  for (const file of files) {
    const source = await sourceFrom(file);
    assert.doesNotMatch(
      source,
      /text-\[(?:10|11)px\]/,
      `${file} still contains visible text below 12px`,
    );
  }
});

test("the conversation AI switch has a programmatic action name", async () => {
  const source = await sourceFrom("../../components/ConversationThread.tsx");
  const switchMarkup = source.match(/<Switch[\s\S]*?\/>/)?.[0] ?? "";

  assert.match(switchMarkup, /aria-label=/);
  assert.match(switchMarkup, /AI 자동 응대/);
});

test("public pool failure states expose their title as the page heading", async () => {
  const source = await sourceFrom("../../app/p/[token]/page.tsx");

  assert.match(source, /<h1[^>]*>링크를 확인할 수 없어요<\/h1>/);
  assert.match(source, /<h1[^>]*>일자리를 불러오지 못했어요<\/h1>/);
});

test("the reports page exposes its primary operating question as an h1", async () => {
  const source = await sourceFrom("../../components/Reports.tsx");

  assert.match(
    source,
    /<h1[^>]*id="report-scope-heading"[^>]*>[\s\S]*?등록 흐름과 매니저 검토 대상을 함께 봅니다[\s\S]*?<\/h1>/,
  );
});

test("manager operation workbenches expose one primary h1", async () => {
  const automation = await sourceFrom("../../components/Automation.tsx");
  const live = await sourceFrom("../../components/LiveConsole.tsx");

  assert.match(automation, /<h1[^>]*>자동화 운영 상태<\/h1>/);
  assert.match(live, /<h1[^>]*>오늘 처리할 지원자 업무<\/h1>/);
});
