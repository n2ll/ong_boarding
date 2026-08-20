export type RegistryOverview =
  | { state: "loading" }
  | { state: "error" }
  | { state: "empty" }
  | { state: "ready"; total: number; active: number; branches: number; activeJobs: number };

export function clientRegistryOverview(input: {
  clients?: { active: boolean; branches_count: number; active_jobs: number }[];
  error?: unknown;
}): RegistryOverview {
  if (input.error) return { state: "error" };
  if (input.clients === undefined) return { state: "loading" };
  if (input.clients.length === 0) return { state: "empty" };

  return input.clients.reduce<Extract<RegistryOverview, { state: "ready" }>>(
    (overview, client) => ({
      ...overview,
      active: overview.active + (client.active ? 1 : 0),
      branches: overview.branches + client.branches_count,
      activeJobs: overview.activeJobs + client.active_jobs,
    }),
    { state: "ready", total: input.clients.length, active: 0, branches: 0, activeJobs: 0 },
  );
}

export type MasterOverview =
  | { state: "loading" }
  | { state: "error" }
  | { state: "unconfigured" }
  | { state: "empty" }
  | { state: "ready"; clients: number; lines: number; workers: number };

export function masterRegistryOverview(input: {
  clients?: { lineCount: number; workerCount: number }[];
  error?: unknown;
  configured?: boolean;
}): MasterOverview {
  if (input.error) return { state: "error" };
  if (input.clients === undefined || input.configured === undefined) return { state: "loading" };
  if (!input.configured) return { state: "unconfigured" };
  if (input.clients.length === 0) return { state: "empty" };

  return input.clients.reduce<Extract<MasterOverview, { state: "ready" }>>(
    (overview, client) => ({
      ...overview,
      lines: overview.lines + client.lineCount,
      workers: overview.workers + client.workerCount,
    }),
    { state: "ready", clients: input.clients.length, lines: 0, workers: 0 },
  );
}

type IntegrityReport = {
  jobs_backfillable: number;
  jobs_client_backfillable: number;
  jobs_unmatched: number;
  jobs_missing_client: number;
  branches_missing_client: number;
};

export type IntegrityOverview =
  | { state: "loading" }
  | { state: "error" }
  | { state: "empty" }
  | { state: "ready"; issues: number; autoFixable: number };

export function integrityOverview(input: {
  report?: IntegrityReport | null;
  error?: unknown;
}): IntegrityOverview {
  if (input.error) return { state: "error" };
  if (input.report === undefined) return { state: "loading" };
  if (input.report === null) return { state: "empty" };

  const autoFixable = input.report.jobs_backfillable + input.report.jobs_client_backfillable;

  return {
    state: "ready",
    autoFixable,
    issues: input.report.jobs_backfillable
      + input.report.jobs_unmatched
      + input.report.jobs_missing_client
      + input.report.branches_missing_client,
  };
}
