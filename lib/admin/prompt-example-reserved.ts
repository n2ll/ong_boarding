export const AGENT_KILL_SWITCH_CATEGORY = "system_message";
export const AGENT_KILL_SWITCH_TITLE = "agent_kill_switch";
export const TASK_QUEUE_RESET_CATEGORY = "system_message";
export const TASK_QUEUE_RESET_TITLE = "__admin_task_queue_reset__";

export function isReservedPromptExampleKey(category: unknown, title: unknown): boolean {
  if (typeof title !== "string") return false;
  const key = title.trim();
  return (
    category === AGENT_KILL_SWITCH_CATEGORY && key === AGENT_KILL_SWITCH_TITLE
  ) || (
    category === TASK_QUEUE_RESET_CATEGORY && key === TASK_QUEUE_RESET_TITLE
  );
}
