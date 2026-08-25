"use client";

import { useCallback, useRef, useState } from "react";
import {
  createApplicantDetailTransitionCoordinator,
  type ApplicantDetailTransitionKind,
  type ApplicantDetailTransitionOutcome,
} from "@/lib/admin/applicant-detail-unsaved";
import { useConfirm } from "./ConfirmDialog";

export type ApplicantDetailDirtyState = {
  applicantId: number;
  applicantName?: string;
  dirty: boolean;
};

type Transition = () => void | Promise<void>;

export function useApplicantDetailUnsavedGuard(
  applicantId: number | null,
  onDirtyStateChange?: (state: ApplicantDetailDirtyState) => void,
) {
  const confirm = useConfirm();
  const dirtyStateRef = useRef<ApplicantDetailDirtyState | null>(null);
  const expectedApplicantIdRef = useRef(applicantId);
  if (expectedApplicantIdRef.current !== applicantId) dirtyStateRef.current = null;
  expectedApplicantIdRef.current = applicantId;
  const [, setDirtyState] = useState<ApplicantDetailDirtyState | null>(null);
  const coordinatorRef = useRef(createApplicantDetailTransitionCoordinator());
  const externalChangeRef = useRef(onDirtyStateChange);
  externalChangeRef.current = onDirtyStateChange;

  const reportDirty = useCallback((state: ApplicantDetailDirtyState) => {
    if (expectedApplicantIdRef.current !== state.applicantId) return;
    dirtyStateRef.current = state;
    setDirtyState(state);
    externalChangeRef.current?.(state);
  }, []);

  const isDirty = Boolean(
    applicantId != null
      && dirtyStateRef.current?.applicantId === applicantId
      && dirtyStateRef.current.dirty,
  );

  const requestTransition = useCallback(async (
    transition: Transition,
    kind: ApplicantDetailTransitionKind = "manual",
  ): Promise<ApplicantDetailTransitionOutcome> => {
    const currentId = expectedApplicantIdRef.current;
    const current = dirtyStateRef.current;
    const dirty = currentId != null && current?.applicantId === currentId && current.dirty;
    const activeElement = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusTarget = currentId == null || typeof document === "undefined"
      ? activeElement
      : document.querySelector<HTMLElement>(`[data-applicant-unsaved-focus="${currentId}"]`) ?? activeElement;

    const outcome = await coordinatorRef.current.run({
      kind,
      dirty,
      confirmDiscard: async () => confirm({
        title: "저장하지 않은 변경이 있어요",
        description: `${current?.applicantName ? `${current.applicantName}님의 ` : ""}투입·운영 정보가 저장되지 않았어요. 이동하면 변경 내용이 사라져요.`,
        cancelText: "계속 편집",
        confirmText: "변경 버리고 이동",
        destructive: true,
      }),
      transition: async () => {
        await transition();
        // 전환 자체가 실패하면 draft 보호를 유지하고, 실제로 진행된 뒤에만 가드를 소비한다.
        if (dirty && current) reportDirty({ ...current, dirty: false });
      },
    });

    if (outcome === "cancelled") {
      requestAnimationFrame(() => focusTarget?.focus());
    }
    return outcome;
  }, [confirm, reportDirty]);

  return { isDirty, reportDirty, requestTransition };
}
