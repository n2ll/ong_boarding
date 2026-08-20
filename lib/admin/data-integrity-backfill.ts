export interface DataIntegrityJob {
  id: number;
  branch: string | null;
  branch_id: number | null;
  client_id: number | null;
}

export interface DataIntegrityBranch {
  id: number;
  name: string;
  client_id: number | null;
}

export interface SafeDataIntegrityBackfillPlan {
  jobBranches: Array<{ jobId: number; branchId: number; clientId: number | null }>;
  jobClients: Array<{ jobId: number; clientId: number }>;
}

function uniqueBranchesByName(branches: DataIntegrityBranch[]): Map<string, DataIntegrityBranch> {
  const grouped = new Map<string, DataIntegrityBranch[]>();
  for (const branch of branches) {
    const name = branch.name.trim();
    if (!name) continue;
    grouped.set(name, [...(grouped.get(name) ?? []), branch]);
  }

  return new Map(
    [...grouped.entries()]
      .filter(([, matches]) => matches.length === 1)
      .map(([name, matches]) => [name, matches[0]]),
  );
}

export function safeDataIntegrityBackfillPlan(
  jobs: DataIntegrityJob[],
  branches: DataIntegrityBranch[],
): SafeDataIntegrityBackfillPlan {
  const uniqueByName = uniqueBranchesByName(branches);
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  const jobBranches: SafeDataIntegrityBackfillPlan["jobBranches"] = [];
  const jobClients: SafeDataIntegrityBackfillPlan["jobClients"] = [];

  for (const job of jobs) {
    if (job.branch_id == null) {
      const branch = uniqueByName.get((job.branch ?? "").trim());
      if (!branch) continue;
      if (job.client_id != null && branch.client_id != null && job.client_id !== branch.client_id) continue;
      jobBranches.push({
        jobId: job.id,
        branchId: branch.id,
        clientId: job.client_id ?? branch.client_id,
      });
      continue;
    }

    if (job.client_id == null) {
      const clientId = byId.get(job.branch_id)?.client_id;
      if (clientId != null) jobClients.push({ jobId: job.id, clientId });
    }
  }

  return { jobBranches, jobClients };
}
