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

test("jobs and pipeline expose their primary context and loading state", async () => {
  const jobs = await sourceFrom("../../components/Jobs.tsx");
  const pipeline = await sourceFrom("../../components/Pipeline.tsx");

  assert.match(jobs, /<h1[^>]*id="jobs-operations-title"[^>]*>공고 운영<\/h1>/);
  const filterGroup = jobs.slice(
    jobs.indexOf('aria-label="화주사로 목록 좁히기"') - 600,
    jobs.indexOf('aria-label="지점으로 목록 좁히기"') + 200,
  );
  assert.doesNotMatch(filterGroup, /focus-within:ring/);
  assert.match(filterGroup, /aria-label="화주사로 목록 좁히기"/);
  assert.match(filterGroup, /aria-label="지점으로 목록 좁히기"/);
  assert.match(
    pipeline,
    /<h1[^>]*className="sr-only"[^>]*>전체 인력을 조건별로 찾고 분류해 연락하는 곳입니다\.<\/h1>/,
  );
  assert.match(
    pipeline,
    /function PipelineSkeleton\(\)[\s\S]*?role="status"[\s\S]*?인재풀을 불러오는 중/,
  );
});

test("topbar popovers use the shared focus and escape lifecycle", async () => {
  const topbar = await sourceFrom("../../components/Topbar.tsx");

  assert.match(
    topbar,
    /import \{ Popover, PopoverContent, PopoverTrigger \} from "@\/components\/ui\/popover"/,
  );
  assert.match(topbar, /<Popover open=\{branchOpen\} onOpenChange=/);
  assert.match(topbar, /<Popover open=\{notifOpen\} onOpenChange=/);
  assert.equal(topbar.match(/<PopoverTrigger asChild>/g)?.length, 2);
  assert.equal(topbar.match(/<PopoverContent/g)?.length, 2);
  assert.doesNotMatch(topbar, /window\.addEventListener\("mousedown"/);
});

test("topbar search never exposes results from a previous query", async () => {
  const topbar = await sourceFrom("../../components/Topbar.tsx");

  assert.match(topbar, /const \[resultsQuery, setResultsQuery\] = useState\(""\)/);
  assert.match(topbar, /setResultsQuery\(q\)/);
  assert.match(topbar, /const resultsAreCurrent = resultsQuery === query\.trim\(\)/);
  assert.match(topbar, /resultsAreCurrent && results\.applicants\.length > 0/);
  assert.match(topbar, /resultsAreCurrent && results\.jobs\.length > 0/);
  assert.match(topbar, /role="status" aria-live="polite" aria-atomic="true" className="sr-only"/);
  assert.doesNotMatch(topbar, /aria-live="polite" className="p-3 bg-background/);
});
