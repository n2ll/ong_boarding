export type ApplicantNavigationFocusTarget = "previous" | "next" | "title";

export function applicantNavigationFocusTarget(
  requestedDirection: "previous" | "next" | null,
  canPrevious: boolean,
  canNext: boolean,
  focusTitleWithoutDirection = false,
): ApplicantNavigationFocusTarget | null {
  if (requestedDirection === null) return focusTitleWithoutDirection ? "title" : null;
  if (requestedDirection === "previous" && canPrevious) return "previous";
  if (requestedDirection === "next" && canNext) return "next";
  if (canPrevious) return "previous";
  if (canNext) return "next";
  return "title";
}

/**
 * 비동기 미저장 확인과 React 렌더 사이에서 방향 포커스를 한 번만 소비한다.
 * 취소된 요청은 남기지 않고, 확인 중 연타는 첫 요청의 방향을 보존한다.
 */
export function createApplicantNavigationFocusCoordinator() {
  let pendingDirection: "previous" | "next" | null = null;

  return {
    async request(
      direction: "previous" | "next",
      transition: () => Promise<boolean>,
    ): Promise<void> {
      if (pendingDirection !== null) return;
      pendingDirection = direction;
      try {
        if (!(await transition())) pendingDirection = null;
      } catch {
        pendingDirection = null;
      }
    },
    consume(
      canPrevious: boolean,
      canNext: boolean,
      focusTitleWithoutDirection = false,
    ): ApplicantNavigationFocusTarget | null {
      const direction = pendingDirection;
      pendingDirection = null;
      return applicantNavigationFocusTarget(
        direction,
        canPrevious,
        canNext,
        focusTitleWithoutDirection,
      );
    },
  };
}
