import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const live = readFileSync(
  new URL("../../components/LiveConsole.tsx", import.meta.url),
  "utf8",
);
const applicantsRoute = readFileSync(
  new URL("../../app/api/admin/applicants/route.ts", import.meta.url),
  "utf8",
);
const applicantDetail = readFileSync(
  new URL("../../components/ApplicantDetailPanel.tsx", import.meta.url),
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
  assert.match(compactHeader, /modeNotice === "draft" \? "border-copilot\/30 bg-copilot-soft text-copilot-strong"/);
  assert.match(compactHeader, /modeNotice === "error" \? "border-error\/30 bg-error-soft text-error-strong"/);
  assert.match(compactHeader, /modeNotice === "stale" \? "border-warning\/30 bg-warning-soft text-warning-strong"/);
});

test("queue health uses operational success and info tones", () => {
  assert.match(
    live,
    /queueSummary\.kind === "clear" && manualMessageAttentionIsClear \? "text-success-strong"/,
  );
  assert.match(
    live,
    /appsValidating[\s\S]*?animate-pulse rounded-full bg-info/,
  );
});

test("manual send attention remains visible across every operations tab", () => {
  const sharedHeader = live.slice(
    live.indexOf('<div className="shrink-0 border-b border-border-strong bg-card px-4 py-2.5 lg:px-5">'),
    live.indexOf('{activeTab === "inbox" ? ('),
  );

  assert.match(sharedHeader, /manualMessageAttentionState === "error"/);
  assert.match(sharedHeader, /발송 확인 \{manualMessageAttentionCount\}건 · 재발송 금지/);
});

test("job-link failures cannot be collapsed into a trustworthy empty list", () => {
  assert.match(
    applicantsRoute,
    /if \(linkErr\)[\s\S]*?status:\s*503/,
  );
  assert.match(live, /if \(!res\.ok\) throw new Error/);
  assert.match(live, /activeJobsStatus/);
});

test("the live detail panel and central conversation share one selected job", () => {
  assert.match(
    live,
    /<ApplicantDetailContent[\s\S]*?focusJobId=\{currentSelectedJobId\}[\s\S]*?onFocusJobChange=/,
  );
  assert.match(applicantDetail, /onFocusJobChange\?:/);
  assert.match(
    live,
    /const handleDetailJobFocus[\s\S]*?selectLiveJob\(jobId\)[\s\S]*?<ConversationThread[\s\S]*?jobId=\{currentSelectedJobId\}/,
  );
});

test("the controlled live detail preserves an explicitly unscoped draft", () => {
  assert.match(
    applicantDetail,
    /const focusJobId\s*=\s*controlled\s*\?[\s\S]*?focusJobIdProp[\s\S]*?:[\s\S]*?focusOverrideLocal\s*\?\?\s*jobId/,
  );
  assert.match(
    applicantDetail,
    /const focusCand\s*=\s*focusJobId\s*!=\s*null[\s\S]*?cands\.find[\s\S]*?:\s*controlled\s*\?\s*null\s*:\s*cands\[0\]/,
  );
});

test("applicant detail never exposes a response owned by the previously selected person", () => {
  assert.match(applicantDetail, /requestSequenceRef/);
  assert.match(applicantDetail, /detail\?\.applicant\.id\s*===\s*applicantId\s*\?\s*detail\s*:\s*null/);
  assert.match(applicantDetail, /requestSequenceRef\.current\s*!==\s*requestSequence/);
});

test("a failed live-list refresh revalidates a list-derived job context before keeping send unlocked", () => {
  assert.match(live, /source:\s*"none"\s*\|\s*"list"\s*\|\s*"endpoint"/);
  assert.match(live, /appsFailed\s*&&\s*activeJobsStatus\.source\s*===\s*"list"[\s\S]*?"loading"/);
  assert.match(live, /forceActiveJobsReloadRef\.current\s*=\s*true[\s\S]*?setActiveJobsReloadKey/);
});

test("queued job focus intent is owned by the applicant who created it", () => {
  assert.match(live, /focusApplicantIdRef/);
  assert.match(live, /focusApplicantIdRef\.current\s*===\s*applicantId/);
  assert.match(live, /focusApplicantIdRef\.current\s*=\s*h\.applicant_id/);
  assert.match(live, /focusApplicantIdRef\.current\s*=\s*applicantId/);
});

test("a late active-jobs response cannot overwrite a newer explicit job selection", () => {
  assert.match(live, /activeJobsSelectionRevisionRef/);
  assert.match(live, /const selectionRevision\s*=\s*activeJobsSelectionRevisionRef\.current/);
  assert.match(live, /activeJobsSelectionRevisionRef\.current\s*!==\s*selectionRevision/);
  assert.match(
    live,
    /selectLiveJob[\s\S]*?activeJobsSelectionRevisionRef\.current\s*\+=\s*1[\s\S]*?setSelectedJobId/,
  );
  assert.match(live, /preserveSelection/);
  assert.match(
    live,
    /apply\(\s*json\.jobs as ActiveJob\[\],\s*"endpoint",\s*activeJobsSelectionRevisionRef\.current\s*!==\s*selectionRevision\s*,?\s*\)/,
  );
  assert.match(
    live,
    /if \(preserveSelection\)[\s\S]*?setActiveJobsStatus\(\{ applicantId, state: "ready", source \}\)/,
  );
});

test("applicant detail load failures provide a nearby retry action", () => {
  assert.match(applicantDetail, /정보를 불러오지 못했어요[\s\S]*?다시 시도/);
});

test("the drawer chat tab distinguishes loading from detail failure and can retry", () => {
  assert.match(applicantDetail, /const \{ detail, loading, reload \}\s*=\s*useApplicantDetail/);
  assert.match(
    applicantDetail,
    /tab\s*===\s*"detail"[\s\S]*?:\s*a\s*\?[\s\S]*?:\s*loading\s*\?[\s\S]*?정보를 불러오지 못했어요[\s\S]*?다시 시도/,
  );
});
