export const APPLICATION_BRANCH_UNASSIGNED = "미지정";

const APPLICATION_BRANCHLESS_VALUES = new Set([
  "",
  "-",
  APPLICATION_BRANCH_UNASSIGNED,
  "미확인",
]);

export type ApplicationBranchContext =
  | { mode: "none" }
  | { mode: "fixed"; branch: string }
  | { mode: "choice"; branches: string[] };

export type ApplicationBranchSubmission =
  | { ok: true; branch1: string; branch2: string | null }
  | { ok: false; field: "branch1" | "branch2"; message: string };

function normalizedBranch(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function applicationBranchName(value: string | null | undefined): string | null {
  const normalized = normalizedBranch(value);
  return APPLICATION_BRANCHLESS_VALUES.has(normalized) ? null : normalized;
}

export function applicationActiveFixedBranchName(input: {
  name: string | null | undefined;
  active: boolean | null | undefined;
  clientId: number | null | undefined;
  jobClientId: number | null;
}): string | null {
  if (input.active !== true) return null;
  if (input.jobClientId !== null && input.clientId !== input.jobClientId) return null;
  return applicationBranchName(input.name);
}

/** 과거 배민 비마트 전용 지원 링크만 source 자체로 지점 선택 맥락을 가진다. */
export function applicationSourceRequiresBranchChoice(source: string): boolean {
  return source === "baemin";
}

export function applicationUsesLegacyBmartFlow(input: {
  source: string;
  branch: string | null | undefined;
}): boolean {
  return input.source === "baemin" && applicationBranchName(input.branch) !== null;
}

function normalizedBranchOptions(branches: readonly string[] | undefined): string[] {
  return Array.from(new Set((branches ?? []).map(applicationBranchName).filter(
    (branch): branch is string => branch !== null,
  )));
}

export function applicationBranchContext(input: {
  fixedBranch?: string | null;
  allowChoice: boolean;
  activeBranches?: readonly string[];
}): ApplicationBranchContext {
  const fixedBranch = applicationBranchName(input.fixedBranch);
  if (fixedBranch) return { mode: "fixed", branch: fixedBranch };

  const branches = normalizedBranchOptions(input.activeBranches);
  if (input.allowChoice && branches.length > 0) return { mode: "choice", branches };
  return { mode: "none" };
}

export function resolveApplicationBranchSubmission(
  context: ApplicationBranchContext,
  requested: { branch1: string; branch2: string },
): ApplicationBranchSubmission {
  if (context.mode === "none") {
    return { ok: true, branch1: APPLICATION_BRANCH_UNASSIGNED, branch2: null };
  }
  if (context.mode === "fixed") {
    return { ok: true, branch1: context.branch, branch2: null };
  }

  const branch1 = applicationBranchName(requested.branch1) ?? "";
  const branch2 = applicationBranchName(requested.branch2) ?? "";
  if (!context.branches.includes(branch1)) {
    return {
      ok: false,
      field: "branch1",
      message: "선택 가능한 희망 지점을 다시 확인해주세요.",
    };
  }
  if (branch2 && !context.branches.includes(branch2)) {
    return {
      ok: false,
      field: "branch2",
      message: "선택 가능한 두 번째 희망 지점을 다시 확인해주세요.",
    };
  }
  if (branch2 && branch2 === branch1) {
    return {
      ok: false,
      field: "branch2",
      message: "1순위와 다른 지점을 선택해주세요.",
    };
  }
  return { ok: true, branch1, branch2: branch2 || null };
}

export function applicationBranchReceiptLine(branch: string | null | undefined): string | null {
  const normalized = applicationBranchName(branch);
  return normalized ? `▶ 지원 근무지: ${normalized}` : null;
}
