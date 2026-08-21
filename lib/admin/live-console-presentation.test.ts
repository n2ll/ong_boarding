import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const live = readFileSync(
  new URL("../../components/LiveConsole.tsx", import.meta.url),
  "utf8",
);

test("the confirmation queue stays visibly pre-confirmation", () => {
  assert.match(
    live,
    /activeTab === "confirm"[\s\S]*?border-stage-screening-ink\/20 bg-stage-screening-soft text-stage-screening-ink/,
  );
  assert.match(
    live,
    /<Badge variant="stage-screening">스크리닝 완료 · 확정 전<\/Badge>/,
  );
  assert.doesNotMatch(live, />온보딩 완료<\/Badge>/);
});

test("a failed conversation collection renders an actionable retry state", () => {
  assert.match(
    live,
    /appsState === "error" && <QueueErrorState label="지원자 대화 목록" onRetry=\{\(\) => void mutateApps\(\)\} \/>/,
  );
});

test("operational signals do not borrow hiring-stage colors", () => {
  const toneStyles = live.slice(
    live.indexOf("const TONE_STYLE"),
    live.indexOf("function ageStyle"),
  );
  const turnPresentation = live.slice(
    live.indexOf("function whoseTurn"),
    live.indexOf("function QueueLoadingState"),
  );
  const compactHeader = live.slice(
    live.indexOf("{modeNotice && ("),
    live.indexOf("{activeTab === \"inbox\""),
  );

  assert.match(toneStyles, /human: "bg-info-soft text-info-strong border-info\/25"/);
  assert.doesNotMatch(toneStyles, /human: "[^"]*stage-/);
  assert.match(turnPresentation, /pending_draft[\s\S]*?bg-copilot-soft text-copilot-strong/);
  assert.match(turnPresentation, /AI 응대 중[\s\S]*?bg-info-soft text-info-strong/);
  assert.doesNotMatch(turnPresentation, /bg-stage-(?:exploration|screening|onboarding|active)-soft/);
  assert.match(compactHeader, /modeNotice === "off"[\s\S]*?: "border-copilot\/30 bg-copilot-soft text-copilot-strong"/);
});

test("queue health uses operational success and info tones", () => {
  assert.match(
    live,
    /queueSummary\.kind === "clear" \? "text-success-strong"/,
  );
  assert.match(
    live,
    /appsValidating[\s\S]*?animate-pulse rounded-full bg-info/,
  );
});
