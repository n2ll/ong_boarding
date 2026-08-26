import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const jobsSource = readFileSync(
  new URL("../../components/Jobs.tsx", import.meta.url),
  "utf8",
);

test("job edit exits share one unsaved-change guard and saving locks dismissal", () => {
  assert.match(jobsSource, /const \[editBaseline, setEditBaseline\] = useState<EditJobForm \| null>\(null\)/);
  assert.match(jobsSource, /const hasUnsavedEditJobDraft = [\s\S]*hasJobEditDraftChanges/);
  assert.match(jobsSource, /const closeEditModal = async \(\) => \{/);
  assert.match(jobsSource, /title: "수정 중인 내용을 버릴까요\?"/);
  assert.match(jobsSource, /const editSavePendingRef = useRef\(false\)/);
  assert.match(jobsSource, /if \(editSaving \|\| editSavePendingRef\.current/);
  assert.match(jobsSource, /editSavePendingRef\.current = true/);
  assert.match(jobsSource, /editSavePendingRef\.current = false/);

  const modalStart = jobsSource.indexOf("{/* 공고 수정 모달");
  const modalEnd = jobsSource.indexOf("{/* 공고 마감 확인 모달", modalStart);
  const modal = jobsSource.slice(modalStart, modalEnd);
  assert.match(modal, /onClose=\{closeEditModal\}/);
  assert.match(modal, /busy=\{editSaving\}/);
  assert.match(modal, /<fieldset disabled=\{editSaving\} className="contents">/);
  assert.equal(modal.match(/onClick=\{closeEditModal\}/g)?.length, 2, "X and cancel must use the same guard");
});

test("closing a loading edit invalidates its late response", () => {
  assert.match(jobsSource, /const editRequestIdRef = useRef\(0\)/);
  const openStart = jobsSource.indexOf("const openEdit = useCallback");
  const openEnd = jobsSource.indexOf("// 두뇌", openStart);
  const openEdit = jobsSource.slice(openStart, openEnd);
  assert.match(openEdit, /const requestId = \+\+editRequestIdRef\.current/);
  assert.match(openEdit, /if \(requestId !== editRequestIdRef\.current\) return/);
  assert.match(openEdit, /setEditLoading\(false\)[\s\S]*requestAnimationFrame\([\s\S]*editTitleRef\.current\?\.focus/);
  assert.match(jobsSource, /editRequestIdRef\.current \+= 1/);
});

test("job create drafts are recovered for 24 hours and cleared only after submit or explicit discard", () => {
  assert.match(jobsSource, /loadJobCreateDraft\(window\.localStorage\)/);
  assert.match(jobsSource, /saveJobCreateDraft\(window\.localStorage, storedNewJobDraft\)/);
  assert.match(jobsSource, /const restoreNewJobDraft = \(\) => \{/);
  assert.match(jobsSource, /const discardRecoverableNewJobDraft = \(\) => \{/);
  assert.match(jobsSource, /removeJobCreateDraft\(window\.localStorage\)/);
  assert.match(jobsSource, /24시간/);
  assert.match(jobsSource, /if \(recoverableNewJobDraft\) return/);
  assert.match(jobsSource, /\{recoverableNewJobDraft && \(/);
  assert.match(jobsSource, /setNewJobSosId\(draft\.sosId\)/);
  assert.match(jobsSource, /setNewJobSosRegion\(draft\.sosRegion\)/);
  assert.match(jobsSource, /setNewJobSosVehicle\(draft\.sosVehicle\)/);
  assert.match(jobsSource, /jobCreateAttemptRef\.current = draft\.createAttempt/);
  assert.match(jobsSource, /saveJobCreateDraft\(window\.localStorage, \{[\s\S]*createAttempt/);
  assert.match(jobsSource, /isLoading:\s*siteManagersLoading/);
  assert.match(jobsSource, /const\s+draftRestoreMetadataUnavailable\s*=/);
  assert.match(jobsSource, /if \(!recoverableNewJobDraft \|\| draftRestoreMetadataUnavailable\) return/);

  const registerModalStart = jobsSource.indexOf("{/* AI JD Generator Modal */}");
  const editModalStart = jobsSource.indexOf("{/* 공고 수정 모달", registerModalStart);
  const registerModal = jobsSource.slice(registerModalStart, editModalStart);
  assert.match(registerModal, /<fieldset disabled=\{registering\} className="contents">/);

  const closeStart = jobsSource.indexOf("const closeRegisterModal = async () => {");
  const closeEnd = jobsSource.indexOf("// 공고 복제", closeStart);
  const closeHandler = jobsSource.slice(closeStart, closeEnd);
  assert.match(closeHandler, /let discardCurrentDraft = false/);
  assert.match(closeHandler, /discardCurrentDraft = true/);
  assert.match(closeHandler, /if \(discardCurrentDraft\) clearStoredNewJobDraft\(\)/);
});

test("new jobs exclude inactive routing options while edits preserve only their current inactive values", () => {
  assert.match(jobsSource, /active: c\.active/);
  assert.match(jobsSource, /active: b\.active/);
  assert.match(jobsSource, /newJobRoutingOptions\(clients\)/);
  assert.match(jobsSource, /newJobRoutingOptions\(branches\)/);
  assert.match(jobsSource, /editJobRoutingOptions\(clients, editForm\?\.clientId \?\? ""\)/);
  assert.match(jobsSource, /editJobRoutingOptions\(branches, editForm\?\.branchId \?\? ""\)/);
  assert.match(jobsSource, /newJobClients\.map/);
  assert.match(jobsSource, /newJobBranches\.filter/);
  assert.match(jobsSource, /editJobClients\.map/);
  assert.match(jobsSource, /editJobBranches\.filter/);
});

test("create and edit submit paths use the same required field validator", () => {
  assert.equal(
    jobsSource.match(/validateJobRequiredFields\(\{/g)?.length,
    2,
    "both submit paths should call the shared validator",
  );
  assert.match(jobsSource, /setEditOpenSections\(\(sections\) => \(\{[\s\S]*work: true/);
});

test("the shared modal can focus a task-specific first field instead of its close button", () => {
  const modalSource = readFileSync(
    new URL("../../components/ui/modal.tsx", import.meta.url),
    "utf8",
  );
  assert.match(modalSource, /initialFocusRef\?: React\.RefObject<HTMLElement>/);
  assert.match(modalSource, /onOpenAutoFocus/);
  assert.match(jobsSource, /initialFocusRef=\{newJobClientRef\}/);
  assert.match(jobsSource, /initialFocusRef=\{editTitleRef\}/);
});
