export function teamDirectoryView(input: {
  members?: unknown[];
  branches?: unknown[];
  memberError?: unknown;
  branchError?: unknown;
}):
  | { state: "loading" }
  | { state: "error"; sources: string[] }
  | { state: "ready"; count: number } {
  const sources = [
    ...(input.memberError ? ["members"] : []),
    ...(input.branchError ? ["branches"] : []),
  ];
  if (sources.length > 0) return { state: "error", sources };
  if (input.members === undefined || input.branches === undefined) return { state: "loading" };
  return { state: "ready", count: input.members.length };
}
