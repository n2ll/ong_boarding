import assert from "node:assert/strict";
import test from "node:test";

type ManagerPanelLayoutModule = {
  shouldDockManagerPanels?: (viewportWidth: number) => boolean;
  shouldDockLiveDetailPanel?: (viewportWidth: number) => boolean;
  shouldShowManagerDetailPanel?: (input: {
    hasActiveChat: boolean;
    canDock: boolean;
    overlayOpen: boolean;
  }) => boolean;
  validManagerDetailOverlayApplicantId?: (input: {
    selectedApplicantId: number | null;
    overlayApplicantId: number | null;
    canDock: boolean;
  }) => number | null;
  liveDetailOverlayApplicantIdAfterDockChange?: (input: {
    selectedApplicantId: number | null;
    overlayApplicantId: number | null;
    wasDocked: boolean;
    canDock: boolean;
  }) => number | null;
  managerPanelKeyboardAction?: (input: {
    key: string;
    shiftKey: boolean;
    activeIndex: number;
    focusableCount: number;
  }) => "close" | "focus-first" | "focus-last" | "focus-panel" | null;
};

async function loadModule(): Promise<ManagerPanelLayoutModule> {
  try {
    return await import(new URL("./manager-panel-layout.ts", import.meta.url).href) as ManagerPanelLayoutModule;
  } catch {
    return {};
  }
}

test("manager detail stays optional through common desktop widths", async () => {
  const { shouldDockManagerPanels } = await loadModule();

  assert.equal(typeof shouldDockManagerPanels, "function");
  assert.equal(shouldDockManagerPanels!(1024), false);
  assert.equal(shouldDockManagerPanels!(1279), false);
  assert.equal(shouldDockManagerPanels!(1280), false);
  assert.equal(shouldDockManagerPanels!(1366), false);
  assert.equal(shouldDockManagerPanels!(1440), false);
  assert.equal(shouldDockManagerPanels!(1535), false);
});

test("manager detail panels dock only when the work area is wide enough", async () => {
  const { shouldDockManagerPanels } = await loadModule();

  assert.equal(typeof shouldDockManagerPanels, "function");
  assert.equal(shouldDockManagerPanels!(1536), true);
});

test("the live conversation keeps at least 640px before docking applicant detail", async () => {
  const { shouldDockLiveDetailPanel } = await loadModule();

  assert.equal(typeof shouldDockLiveDetailPanel, "function");
  assert.equal(shouldDockLiveDetailPanel!(1536), false);
  assert.equal(shouldDockLiveDetailPanel!(1679), false);
  assert.equal(shouldDockLiveDetailPanel!(1680), true);
});

test("a laptop conversation does not open the detail overlay until the manager asks", async () => {
  const { shouldShowManagerDetailPanel } = await loadModule();

  assert.equal(typeof shouldShowManagerDetailPanel, "function");
  assert.equal(shouldShowManagerDetailPanel!({
    hasActiveChat: true,
    canDock: false,
    overlayOpen: false,
  }), false);
  assert.equal(shouldShowManagerDetailPanel!({
    hasActiveChat: true,
    canDock: false,
    overlayOpen: true,
  }), true);
});

test("a desktop conversation keeps its contextual detail panel docked", async () => {
  const { shouldShowManagerDetailPanel } = await loadModule();

  assert.equal(typeof shouldShowManagerDetailPanel, "function");
  assert.equal(shouldShowManagerDetailPanel!({
    hasActiveChat: true,
    canDock: true,
    overlayOpen: false,
  }), true);
  assert.equal(shouldShowManagerDetailPanel!({
    hasActiveChat: false,
    canDock: true,
    overlayOpen: true,
  }), false);
});

test("detail overlay intent is discarded after queue advance or docking", async () => {
  const { validManagerDetailOverlayApplicantId } = await loadModule();

  assert.equal(typeof validManagerDetailOverlayApplicantId, "function");
  assert.equal(validManagerDetailOverlayApplicantId!({
    selectedApplicantId: 10,
    overlayApplicantId: 10,
    canDock: false,
  }), 10);
  assert.equal(validManagerDetailOverlayApplicantId!({
    selectedApplicantId: 11,
    overlayApplicantId: 10,
    canDock: false,
  }), null);
  assert.equal(validManagerDetailOverlayApplicantId!({
    selectedApplicantId: 10,
    overlayApplicantId: 10,
    canDock: true,
  }), null);
});

test("a docked live detail becomes the same applicant overlay before narrowing the viewport", async () => {
  const { liveDetailOverlayApplicantIdAfterDockChange } = await loadModule();

  assert.equal(typeof liveDetailOverlayApplicantIdAfterDockChange, "function");
  assert.equal(liveDetailOverlayApplicantIdAfterDockChange!({
    selectedApplicantId: 42,
    overlayApplicantId: null,
    wasDocked: true,
    canDock: false,
  }), 42);
  assert.equal(liveDetailOverlayApplicantIdAfterDockChange!({
    selectedApplicantId: null,
    overlayApplicantId: null,
    wasDocked: true,
    canDock: false,
  }), null);
  assert.equal(liveDetailOverlayApplicantIdAfterDockChange!({
    selectedApplicantId: 42,
    overlayApplicantId: 42,
    wasDocked: false,
    canDock: true,
  }), null);
});

test("an invalid viewport measurement never enables docking", async () => {
  const { shouldDockManagerPanels } = await loadModule();

  assert.equal(typeof shouldDockManagerPanels, "function");
  assert.equal(shouldDockManagerPanels!(Number.NaN), false);
});

test("Escape closes an overlaid manager panel", async () => {
  const { managerPanelKeyboardAction } = await loadModule();

  assert.equal(typeof managerPanelKeyboardAction, "function");
  assert.equal(managerPanelKeyboardAction!({
    key: "Escape",
    shiftKey: false,
    activeIndex: 0,
    focusableCount: 3,
  }), "close");
});

test("Tab stays inside the first and last controls of an overlaid manager panel", async () => {
  const { managerPanelKeyboardAction } = await loadModule();

  assert.equal(typeof managerPanelKeyboardAction, "function");
  assert.equal(managerPanelKeyboardAction!({
    key: "Tab",
    shiftKey: false,
    activeIndex: 2,
    focusableCount: 3,
  }), "focus-first");
  assert.equal(managerPanelKeyboardAction!({
    key: "Tab",
    shiftKey: true,
    activeIndex: 0,
    focusableCount: 3,
  }), "focus-last");
  assert.equal(managerPanelKeyboardAction!({
    key: "Tab",
    shiftKey: false,
    activeIndex: 1,
    focusableCount: 3,
  }), null);
});

test("a panel with no controls keeps keyboard focus on the panel", async () => {
  const { managerPanelKeyboardAction } = await loadModule();

  assert.equal(typeof managerPanelKeyboardAction, "function");
  assert.equal(managerPanelKeyboardAction!({
    key: "Tab",
    shiftKey: false,
    activeIndex: -1,
    focusableCount: 0,
  }), "focus-panel");
});
