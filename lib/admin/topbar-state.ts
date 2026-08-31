export function topbarCollectionState(input: {
  items?: unknown[];
  error?: unknown;
}): "loading" | "error" | "empty" | "ready" {
  if (input.error) return "error";
  if (input.items === undefined) return "loading";
  return input.items.length === 0 ? "empty" : "ready";
}

export function topbarRouteCapabilities(pathname: string): {
  showBranchScope: boolean;
  showCreateJobAction: boolean;
} {
  const isPipeline = pathname === "/pipeline" || pathname.startsWith("/pipeline/");
  const isJobs = pathname === "/jobs" || pathname.startsWith("/jobs/");

  return {
    showBranchScope: pathname === "/" || isPipeline,
    showCreateJobAction: !isJobs,
  };
}
