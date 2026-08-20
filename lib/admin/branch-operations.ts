export type BranchOverview =
  | { state: "loading" }
  | { state: "error"; sources: string[] }
  | { state: "ready"; activeBranches: number; knowledgeGaps: number };

type BranchSource = "branches" | "applicants" | "jobs" | "managers" | "clients";

export function branchOverview(input: {
  branches?: { active: boolean; ai_facts?: string | null }[];
  applicants?: unknown[];
  jobs?: unknown[];
  managers?: unknown[];
  clients?: unknown[];
  errors?: Partial<Record<BranchSource, unknown>>;
}): BranchOverview {
  const sourceOrder: BranchSource[] = ["branches", "applicants", "jobs", "managers", "clients"];
  const failedSources = sourceOrder.filter((source) => Boolean(input.errors?.[source]));
  if (failedSources.length > 0) return { state: "error", sources: failedSources };
  if (sourceOrder.some((source) => input[source] === undefined)) return { state: "loading" };

  const active = input.branches!.filter((branch) => branch.active);
  return {
    state: "ready",
    activeBranches: active.length,
    knowledgeGaps: active.filter((branch) => !branch.ai_facts?.trim()).length,
  };
}

export function branchSavePayload(form: {
  name: string;
  active: boolean;
  clientId: number | null;
  slotCapacity: Record<string, number>;
  aiFacts: string;
}): {
  name: string;
  active: boolean;
  client_id: number | null;
  slot_capacity: Record<string, number>;
  ai_facts: string | null;
} {
  return {
    name: form.name.trim(),
    active: form.active,
    client_id: form.clientId,
    slot_capacity: form.slotCapacity,
    ai_facts: form.aiFacts.trim() || null,
  };
}

export function branchCreateValues(body: Record<string, unknown>): {
  name: string;
  active: boolean;
  client_id: number | null;
  slot_capacity: Record<string, number> | null;
  ai_facts: string | null;
} {
  const rawCapacity = body.slot_capacity;
  const slotCapacity = rawCapacity && typeof rawCapacity === "object" && !Array.isArray(rawCapacity)
    ? Object.fromEntries(
        Object.entries(rawCapacity).flatMap(([key, value]) =>
          typeof value === "number" && Number.isFinite(value)
            ? [[key, Math.max(0, value)]]
            : [],
        ),
      )
    : null;
  const facts = typeof body.ai_facts === "string" ? body.ai_facts.trim() : "";

  return {
    name: typeof body.name === "string" ? body.name.trim() : "",
    active: typeof body.active === "boolean" ? body.active : true,
    client_id: typeof body.client_id === "number" ? body.client_id : null,
    slot_capacity: slotCapacity,
    ai_facts: facts || null,
  };
}
