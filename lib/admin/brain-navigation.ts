export type BrainTab = "overview" | "mode" | "rules" | "knowledge" | "persona" | "simulator" | "improve";

const BRAIN_TABS = new Set<BrainTab>([
  "overview",
  "mode",
  "rules",
  "knowledge",
  "persona",
  "simulator",
  "improve",
]);

export function brainTabFromParam(value: string | null): BrainTab {
  if (value === "advanced") return "mode";
  return value && BRAIN_TABS.has(value as BrainTab) ? value as BrainTab : "overview";
}

export function brainTabHref(tab: BrainTab): string {
  return tab === "overview" ? "/brain" : `/brain?tab=${tab}`;
}
