export type RemoteCollectionState = "loading" | "error" | "empty" | "ready";

export function remoteCollectionState(input: {
  items?: unknown[];
  error?: unknown;
}): RemoteCollectionState {
  if (input.error) return "error";
  if (input.items === undefined) return "loading";
  return input.items.length === 0 ? "empty" : "ready";
}

export type RemoteSourcesState =
  | { state: "loading"; pending: string[] }
  | { state: "error"; failed: string[] }
  | { state: "ready" };

export function remoteSourcesState(
  sources: Record<string, { data?: unknown; error?: unknown }>,
): RemoteSourcesState {
  const entries = Object.entries(sources);
  const failed = entries.filter(([, source]) => Boolean(source.error)).map(([name]) => name);
  if (failed.length > 0) return { state: "error", failed };

  const pending = entries.filter(([, source]) => source.data === undefined).map(([name]) => name);
  if (pending.length > 0) return { state: "loading", pending };

  return { state: "ready" };
}
