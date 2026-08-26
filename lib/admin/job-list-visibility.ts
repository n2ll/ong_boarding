export type JobListTab = "active" | "closed" | "all";
export type JobListHiddenBy = "status" | "client" | "branch" | "query";

export type JobListFilterCandidate = {
  title: string;
  branch: string;
  clientId: number | null;
  branchId: number | null;
  effectivelyClosed: boolean;
};

export type JobListFilters = {
  tab: JobListTab;
  clientId: number | "";
  branchId: number | "";
  query: string;
};

export type JobListVisibility = {
  visible: boolean;
  hiddenBy: JobListHiddenBy[];
};

export function jobListVisibility(
  job: JobListFilterCandidate,
  filters: JobListFilters,
): JobListVisibility {
  const hiddenBy: JobListHiddenBy[] = [];
  if (
    (filters.tab === "active" && job.effectivelyClosed)
    || (filters.tab === "closed" && !job.effectivelyClosed)
  ) {
    hiddenBy.push("status");
  }
  if (filters.clientId !== "" && job.clientId !== filters.clientId) hiddenBy.push("client");
  if (filters.branchId !== "" && job.branchId !== filters.branchId) hiddenBy.push("branch");

  const query = filters.query.trim();
  if (query && !job.title.includes(query) && !job.branch.includes(query)) hiddenBy.push("query");

  return { visible: hiddenBy.length === 0, hiddenBy };
}

/** 현재 작업 맥락을 최대한 보존하면서, 해당 공고를 가리는 조건만 해제한다. */
export function filtersToRevealJob(
  job: JobListFilterCandidate,
  filters: JobListFilters,
): JobListFilters {
  const hidden = new Set(jobListVisibility(job, filters).hiddenBy);
  return {
    tab: hidden.has("status") ? (job.effectivelyClosed ? "closed" : "active") : filters.tab,
    clientId: hidden.has("client") ? "" : filters.clientId,
    branchId: hidden.has("branch") ? "" : filters.branchId,
    query: hidden.has("query") ? "" : filters.query,
  };
}
