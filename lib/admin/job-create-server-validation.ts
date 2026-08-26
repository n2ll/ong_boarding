export type JobCreateRequiredField =
  | "capacity"
  | "pickupAddress"
  | "dropoffAddress"
  | "payInfo";

export interface JobCreateRequiredFieldsInput {
  capacity: unknown;
  pickupAddress: unknown;
  dropoffAddress: unknown;
  payInfo: unknown;
}

export interface JobCreateRequiredFieldIssue {
  field: JobCreateRequiredField;
  error: string;
}

export function validateJobCreateRequiredFields({
  capacity,
  pickupAddress,
  dropoffAddress,
  payInfo,
}: JobCreateRequiredFieldsInput): JobCreateRequiredFieldIssue | null {
  if (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1) {
    return { field: "capacity", error: "모집 인원은 1명 이상의 정수로 입력해주세요." };
  }
  if (typeof pickupAddress !== "string" || !pickupAddress.trim()) {
    return { field: "pickupAddress", error: "상차지·집결지를 입력해주세요." };
  }
  if (typeof dropoffAddress !== "string" || !dropoffAddress.trim()) {
    return { field: "dropoffAddress", error: "배송 권역 또는 마지막 경유지를 입력해주세요." };
  }
  if (typeof payInfo !== "string" || !payInfo.trim()) {
    return { field: "payInfo", error: "지원자에게 안내할 급여·정산 내용을 입력해주세요." };
  }
  return null;
}

export interface JobCreateClientRoutingRow {
  id: number;
  active: boolean;
}

export interface JobCreateBranchRoutingRow {
  id: number;
  name: string;
  client_id: number | null;
  active: boolean;
}

export type JobCreateRoutingResult =
  | {
      ok: true;
      branchId: number | null;
      branchName: string | null;
      clientId: number | null;
      error?: never;
    }
  | {
      ok: false;
      error: string;
      branchId?: never;
      branchName?: never;
      clientId?: never;
    };

function optionalPositiveId(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

export function resolveJobCreateRouting(input: {
  requestedClientId: unknown;
  requestedBranchId: unknown;
  requestedBranchName?: unknown;
  branch: JobCreateBranchRoutingRow | null;
  client: JobCreateClientRoutingRow | null;
}): JobCreateRoutingResult {
  const requestedClientId = optionalPositiveId(input.requestedClientId);
  if (requestedClientId === undefined) {
    return { ok: false, error: "client_id 값이 잘못되었습니다." };
  }

  const requestedBranchId = optionalPositiveId(input.requestedBranchId);
  if (requestedBranchId === undefined) {
    return { ok: false, error: "branch_id 값이 잘못되었습니다." };
  }

  const branchName =
    typeof input.requestedBranchName === "string" && input.requestedBranchName.trim()
      ? input.requestedBranchName.trim()
      : null;

  if (requestedBranchId !== null) {
    if (!input.branch || input.branch.id !== requestedBranchId) {
      return { ok: false, error: "선택한 지점을 찾을 수 없습니다." };
    }
    if (!input.branch.active) {
      return { ok: false, error: "선택한 지점이 비활성 상태입니다." };
    }
    if (typeof input.branch.client_id !== "number") {
      return { ok: false, error: "선택한 지점에 소속 화주사가 없습니다." };
    }
    if (requestedClientId !== null && input.branch.client_id !== requestedClientId) {
      return { ok: false, error: "선택한 지점이 선택한 화주사 소속이 아닙니다." };
    }
    if (!input.client || input.client.id !== input.branch.client_id) {
      return { ok: false, error: "선택한 지점의 화주사를 찾을 수 없습니다." };
    }
    if (!input.client.active) {
      return { ok: false, error: "선택한 지점의 화주사가 비활성 상태입니다." };
    }
    return {
      ok: true,
      branchId: requestedBranchId,
      branchName: input.branch.name,
      clientId: input.branch.client_id,
    };
  }

  if (requestedClientId !== null) {
    if (!input.client || input.client.id !== requestedClientId) {
      return { ok: false, error: "선택한 화주사를 찾을 수 없습니다." };
    }
    if (!input.client.active) {
      return { ok: false, error: "선택한 화주사가 비활성 상태입니다." };
    }
  }

  return {
    ok: true,
    branchId: null,
    branchName,
    clientId: requestedClientId,
  };
}
