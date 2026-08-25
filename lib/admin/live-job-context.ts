import type { ConversationJobContext } from "@/lib/conversation-thread-view";

export function liveConversationJobContext(input: {
  activeApplicantId: number;
  ownerApplicantId: number | null;
  loadState: "idle" | "loading" | "error" | "ready";
  jobs: ReadonlyArray<{ job_id: number; title: string; branch: string | null }>;
  selectedJobId: number | null;
  unscopedDraft: boolean;
}): ConversationJobContext {
  if (input.ownerApplicantId !== input.activeApplicantId || input.loadState === "idle" || input.loadState === "loading") {
    return { state: "loading" };
  }
  if (input.loadState === "error") return { state: "error" };
  if (input.unscopedDraft) {
    return { state: "ready", scope: "unscoped-draft", job: null };
  }
  if (input.selectedJobId === null) {
    return input.jobs.length === 0
      ? { state: "ready", scope: "general", job: null }
      : { state: "error" };
  }
  const selected = input.jobs.find((job) => job.job_id === input.selectedJobId);
  if (!selected) return { state: "error" };
  return {
    state: "ready",
    scope: "job",
    job: {
      id: selected.job_id,
      title: selected.title,
      branch: selected.branch,
    },
  };
}
