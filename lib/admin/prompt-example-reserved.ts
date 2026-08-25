export const AGENT_KILL_SWITCH_CATEGORY = "system_message";
export const AGENT_KILL_SWITCH_TITLE = "agent_kill_switch";

export function isReservedPromptExampleKey(category: unknown, title: unknown): boolean {
  return category === AGENT_KILL_SWITCH_CATEGORY
    && typeof title === "string"
    && title.trim() === AGENT_KILL_SWITCH_TITLE;
}
