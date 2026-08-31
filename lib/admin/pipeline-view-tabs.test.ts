import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceFrom = (path: string) =>
  readFile(new URL(path, import.meta.url), "utf8");

test("the Pipeline view switcher uses the shared controlled tab contract", async () => {
  const [pipeline, tabs] = await Promise.all([
    sourceFrom("../../components/Pipeline.tsx"),
    sourceFrom("../../components/ui/tabs.tsx"),
  ]);
  const switcher = pipeline.slice(
    pipeline.indexOf("<Tabs"),
    pipeline.indexOf("{/* 스플릿 뷰"),
  );

  assert.match(tabs, /TabsPrimitive\.Root/);
  assert.match(tabs, /TabsPrimitive\.List/);
  assert.match(tabs, /TabsPrimitive\.Trigger/);
  assert.match(pipeline, /import \{ Tabs, TabsList, TabsTrigger \} from "@\/components\/ui\/tabs"/);
  assert.match(switcher, /<Tabs[\s\S]*?value=\{view\}[\s\S]*?onValueChange=\{\(nextView\) => changeView\(nextView as PipelineView\)\}/);
  assert.match(switcher, /<TabsList[^>]*aria-label="인재풀 보기 방식"/);

  for (const value of ["list", "kanban", "map", "funnel"]) {
    assert.match(switcher, new RegExp(`<TabsTrigger[^>]*value="${value}"`));
  }

  assert.match(switcher, /data-\[state=active\]:bg-white/);
  assert.match(switcher, /data-\[state=active\]:text-foreground/);
  assert.match(switcher, /data-\[state=active\]:shadow-xs/);
  assert.doesNotMatch(switcher, /<button/);
  assert.match(
    pipeline,
    /const changeView = \(next: PipelineView\) => \{[\s\S]*?setView\(next\);[\s\S]*?window\.history\.replaceState\(window\.history\.state, "", pipelineViewHref\(next, searchParams\.toString\(\)\)\);/,
  );
  assert.doesNotMatch(pipeline, /useRouter|router\.replace/);
  assert.match(
    pipeline,
    /useEffect\(\(\) => \{[\s\S]*?setView\(pipelineViewFromSearch\(searchParams\.toString\(\)\)\);/,
  );
  assert.doesNotMatch(
    pipeline,
    /const v = searchParams\.get\("view"\);[\s\S]*?if \(v === "map"/,
  );
});
