import assert from "node:assert/strict";
import test from "node:test";

type ManagerPanelLayoutModule = {
  shouldDockManagerPanels?: (viewportWidth: number) => boolean;
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

test("manager detail panels stay overlaid on laptop-width desktops", async () => {
  const { shouldDockManagerPanels } = await loadModule();

  assert.equal(typeof shouldDockManagerPanels, "function");
  assert.equal(shouldDockManagerPanels!(1024), false);
  assert.equal(shouldDockManagerPanels!(1279), false);
  assert.equal(shouldDockManagerPanels!(1280), false);
  assert.equal(shouldDockManagerPanels!(1366), false);
  assert.equal(shouldDockManagerPanels!(1439), false);
  assert.equal(shouldDockManagerPanels!(1440), false);
  assert.equal(shouldDockManagerPanels!(1535), false);
});

test("manager detail panels dock only on wide desktops", async () => {
  const { shouldDockManagerPanels } = await loadModule();

  assert.equal(typeof shouldDockManagerPanels, "function");
  assert.equal(shouldDockManagerPanels!(1536), true);
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
