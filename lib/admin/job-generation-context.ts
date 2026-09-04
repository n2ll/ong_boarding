export type JobGenerationContextField =
  | "prompt"
  | "client"
  | "branch"
  | "pickupAddress"
  | "dropoffAddress"
  | "capacity"
  | "payInfo";

export interface JobGenerationContextInput {
  prompt: string;
  clientId: number | "";
  branchId: number | "";
  pickupAddress: string;
  dropoffAddress: string;
  capacity: number | "";
  payInfo: string;
}

export interface JobGenerationContext {
  prompt: string;
  clientId: number | null;
  branchId: number | null;
  pickupAddress: string;
  dropoffAddress: string;
  capacity: number | null;
  payInfo: string;
}

function normalizeLocation(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function createJobGenerationContext({
  prompt,
  clientId,
  branchId,
  pickupAddress,
  dropoffAddress,
  capacity,
  payInfo,
}: JobGenerationContextInput): JobGenerationContext {
  return {
    prompt: prompt.trim(),
    clientId: clientId === "" ? null : clientId,
    branchId: branchId === "" ? null : branchId,
    pickupAddress: normalizeLocation(pickupAddress),
    dropoffAddress: normalizeLocation(dropoffAddress),
    capacity: capacity === "" ? null : capacity,
    payInfo: normalizeLocation(payInfo),
  };
}

export function changedJobGenerationContextFields(
  generatedContext: JobGenerationContext | null,
  currentContext: JobGenerationContext,
): JobGenerationContextField[] {
  if (!generatedContext) return [];

  const changed: JobGenerationContextField[] = [];
  if (generatedContext.prompt !== currentContext.prompt) changed.push("prompt");
  if (generatedContext.clientId !== currentContext.clientId) changed.push("client");
  if (generatedContext.branchId !== currentContext.branchId) changed.push("branch");
  if (generatedContext.pickupAddress !== currentContext.pickupAddress) changed.push("pickupAddress");
  if (generatedContext.dropoffAddress !== currentContext.dropoffAddress) changed.push("dropoffAddress");
  if (generatedContext.capacity !== currentContext.capacity) changed.push("capacity");
  if (generatedContext.payInfo !== currentContext.payInfo) changed.push("payInfo");
  return changed;
}

export function resolveJobGenerationAutofill({
  currentValue,
  previousGeneratedValue,
  nextGeneratedValue,
}: {
  currentValue: string;
  previousGeneratedValue: string | null;
  nextGeneratedValue: string;
}): { value: string; generatedValue: string | null } {
  const canReplace = !currentValue || (
    previousGeneratedValue !== null && currentValue === previousGeneratedValue
  );
  if (!canReplace) return { value: currentValue, generatedValue: null };

  return {
    value: nextGeneratedValue,
    generatedValue: nextGeneratedValue || null,
  };
}
