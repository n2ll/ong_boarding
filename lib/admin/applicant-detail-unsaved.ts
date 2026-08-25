export type ApplicantDetailTransitionKind = "manual" | "automatic";
export type ApplicantDetailTransitionOutcome =
  | "proceeded"
  | "cancelled"
  | "deferred"
  | "ignored";

export type ApplicantDetailTransitionRequest = {
  kind: ApplicantDetailTransitionKind;
  dirty: boolean;
  confirmDiscard: () => Promise<boolean>;
  transition: () => void | Promise<void>;
};

/**
 * 미저장 상세 편집에서 일어나는 이동을 한 번에 하나만 처리한다.
 * 자동 갱신은 입력 중 모달을 띄우지 않고 보류하며, 명시적 이동만 폐기 확인을 받는다.
 */
export function createApplicantDetailTransitionCoordinator() {
  let pending = false;

  return {
    async run(request: ApplicantDetailTransitionRequest): Promise<ApplicantDetailTransitionOutcome> {
      if (pending) return "ignored";
      if (request.dirty && request.kind === "automatic") return "deferred";

      pending = true;
      try {
        if (request.dirty && !(await request.confirmDiscard())) return "cancelled";
        await request.transition();
        return "proceeded";
      } finally {
        pending = false;
      }
    },
  };
}

export type ApplicantDetailDraftFieldKind = "text" | "nullable-boolean" | "exact";

export function applicantDetailDraftValuesEqual(
  originalValue: unknown,
  nextValue: unknown,
  kind: ApplicantDetailDraftFieldKind,
): boolean {
  if (kind === "text") {
    return String(originalValue ?? "") === String(nextValue ?? "");
  }
  if (kind === "nullable-boolean") {
    return Boolean(originalValue) === Boolean(nextValue);
  }
  return Object.is(originalValue, nextValue);
}

export function updateApplicantDetailDraft<T extends object, K extends keyof T>(
  draft: Partial<T>,
  field: K,
  originalValue: T[K],
  nextValue: T[K],
  kind: ApplicantDetailDraftFieldKind,
): Partial<T> {
  const nextDraft = { ...draft };
  if (applicantDetailDraftValuesEqual(originalValue, nextValue, kind)) {
    delete nextDraft[field];
  } else {
    nextDraft[field] = nextValue;
  }
  return nextDraft;
}
