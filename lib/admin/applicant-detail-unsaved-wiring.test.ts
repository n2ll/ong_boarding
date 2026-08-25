import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = (name: string) => readFile(
  new URL(`../../components/${name}`, import.meta.url),
  "utf8",
);

test("the shared detail panel guards every internal exit and reports its draft globally", async () => {
  const source = await component("ApplicantDetailPanel.tsx");

  assert.match(source, /onClick=\{\(\) => void requestPanelTransition\(onClose\)\}/);
  assert.match(source, /requestPanelTransition\(\(\) => setTab\(t\.id\)\)/);
  assert.match(source, /onOpenChat=\{\(\) => \{ void requestPanelTransition\(\(\) => setTab\("chat"\)\); \}\}/);
  assert.match(source, /reportApplicantDirty\(state\)/);
  assert.match(source, /reportApplicantDirty\(\{ applicantId, dirty: false \}\)/);
});

test("job context and inline suntop drafts join the same dirty contract", async () => {
  const [detail, live] = await Promise.all([
    component("ApplicantDetailPanel.tsx"),
    component("LiveConsole.tsx"),
  ]);

  assert.match(detail, /const suntopDraftDirty =/);
  assert.match(detail, /const dirty = managedFieldsDirty \|\| suntopDraftDirty/);
  assert.match(detail, /requestFocusJobChange/);
  assert.match(live, /requestLiveJobSelection/);
});

test("manager field controls cannot change underneath an in-flight save", async () => {
  const source = await component("ApplicantDetailPanel.tsx");
  const setFieldBody = source.slice(source.indexOf("const setField ="), source.indexOf("const toggleSlot ="));

  assert.match(setFieldBody, /if \(busy\) return/);
  assert.match(source, /disabled=\{busy\}/);
});

test("a failed local transition does not consume the dirty guard", async () => {
  const source = await component("useApplicantDetailUnsavedGuard.ts");
  const transitionBody = source.slice(source.indexOf("transition: async () =>"), source.indexOf("},\n    });", source.indexOf("transition: async () =>")));

  assert.ok(transitionBody.indexOf("await transition()") < transitionBody.indexOf("reportDirty"));
});

test("non-save applicant mutations do not consume the manager's draft", async () => {
  const source = await component("ApplicantDetailPanel.tsx");
  const patchBody = source.slice(source.indexOf("const patch = async"), source.indexOf("// 재채용 블랙리스트"));

  assert.doesNotMatch(patchBody, /setEdit\(\{\}\)/);
  assert.match(source, /const ok = await patch\(submitted, "저장했어요\."\)/);
});

test("docked Pipeline and Jobs selections report and guard detail drafts", async () => {
  const [pipeline, jobs] = await Promise.all([
    component("Pipeline.tsx"),
    component("Jobs.tsx"),
  ]);

  for (const source of [pipeline, jobs]) {
    assert.match(source, /useApplicantDetailUnsavedGuard\(selectedApplicantId\)/);
    assert.match(source, /onDirtyChange=\{applicantUnsavedGuard\.reportDirty\}/);
    assert.match(source, /applicantUnsavedGuard\.requestTransition/);
  }
});

test("Live freezes automatic queue movement while applicant detail is dirty", async () => {
  const source = await component("LiveConsole.tsx");

  assert.match(source, /nextId !== selectedChatId && applicantDetailDirty/);
  assert.match(source, /deferredReplyCompletionRef\.current/);
  assert.match(source, /목록이 갱신됐어요\. 변경사항을 저장하거나 변경을 취소하면 다음 지원자로 이동합니다\./);
  assert.match(source, /onDirtyChange=\{reportApplicantDetailDirty\}/);
});
