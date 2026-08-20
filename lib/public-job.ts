export function publicJobAvailability(job: {
  title: string | null;
  status: string | null;
  exposure: string | null;
  recruitMode: string | null;
  closesAt?: string | null;
}, nowMs = Date.now()): "open" | "closed" | "hidden" {
  if (!job.title?.trim() || !job.status || !job.recruitMode) return "hidden";
  if (
    job.title.startsWith("__")
    || job.exposure === "targeted"
    || (job.recruitMode !== "external" && job.recruitMode !== "both")
  ) return "hidden";
  const closesAtMs = job.closesAt ? Date.parse(job.closesAt) : Number.NaN;
  if (Number.isFinite(closesAtMs) && closesAtMs <= nowMs) return "closed";
  return job.status === "active" ? "open" : "closed";
}
