export const MANAGER_PANEL_DOCK_MIN_WIDTH = 1280;

export function shouldDockManagerPanels(viewportWidth: number): boolean {
  return Number.isFinite(viewportWidth) && viewportWidth >= MANAGER_PANEL_DOCK_MIN_WIDTH;
}

export type ManagerPanelKeyboardAction =
  | "close"
  | "focus-first"
  | "focus-last"
  | "focus-panel"
  | null;

export function managerPanelKeyboardAction(input: {
  key: string;
  shiftKey: boolean;
  activeIndex: number;
  focusableCount: number;
}): ManagerPanelKeyboardAction {
  if (input.key === "Escape") return "close";
  if (input.key !== "Tab") return null;
  if (input.focusableCount === 0) return "focus-panel";
  if (input.shiftKey && input.activeIndex <= 0) return "focus-last";
  if (!input.shiftKey && input.activeIndex === input.focusableCount - 1) return "focus-first";
  return null;
}
