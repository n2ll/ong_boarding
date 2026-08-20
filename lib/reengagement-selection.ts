import { createHash } from "node:crypto";

type ReengagementCandidate = { phone: string };

export function reengagementCandidateKey(phone: string): string {
  return createHash("sha256").update(phone).digest("hex").slice(0, 16);
}

export function selectedReengagementCandidates<T extends ReengagementCandidate>(
  candidates: T[],
  keys: string[],
): T[] {
  const selected = new Set(keys);
  if (selected.size === 0) return [];
  return candidates.filter((candidate) => selected.has(reengagementCandidateKey(candidate.phone)));
}
