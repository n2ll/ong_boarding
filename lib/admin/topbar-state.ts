export function topbarCollectionState(input: {
  items?: unknown[];
  error?: unknown;
}): "loading" | "error" | "empty" | "ready" {
  if (input.error) return "error";
  if (input.items === undefined) return "loading";
  return input.items.length === 0 ? "empty" : "ready";
}
