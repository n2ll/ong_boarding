export interface PoolJobGroupingFields {
  expired: boolean;
  fit: "ok" | "warn" | "unknown";
  status: "none" | "interested" | "talking" | "paused" | "ended";
}

export function poolJobGroups<T extends PoolJobGroupingFields>(jobs: T[]): {
  activeCount: number;
  main: T[];
  others: T[];
  expired: T[];
  forceShowOthers: boolean;
} {
  const active = jobs.filter((job) => !job.expired);
  const isFolded = (job: T) => job.fit === "warn" && job.status === "none";
  const main = active.filter((job) => !isFolded(job));
  const others = active.filter(isFolded);

  return {
    activeCount: active.length,
    main,
    others,
    expired: jobs.filter((job) => job.expired),
    forceShowOthers: main.length === 0 && others.length > 0,
  };
}
