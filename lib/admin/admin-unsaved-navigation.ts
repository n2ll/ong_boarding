export type AdminUnsavedApplicantState = {
  applicantId: number;
  applicantName?: string;
  dirty: boolean;
};

export type AdminNavigationClickIntent = {
  currentHref: string;
  href: string;
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: string | null;
  download?: boolean;
};

export function internalNavigationHrefForGuard(
  intent: AdminNavigationClickIntent,
): string | null {
  if ((intent.button ?? 0) !== 0) return null;
  if (intent.metaKey || intent.ctrlKey || intent.shiftKey || intent.altKey) return null;
  if (intent.download) return null;
  if (intent.target && intent.target.toLowerCase() !== "_self") return null;

  try {
    const current = new URL(intent.currentHref);
    const destination = new URL(intent.href, current);
    if (!["http:", "https:"].includes(destination.protocol)) return null;
    if (destination.origin !== current.origin) return null;
    // 같은 문서 안의 앵커 이동은 편집 화면을 떠나지 않는다.
    if (destination.pathname === current.pathname && destination.search === current.search) return null;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return null;
  }
}

export function nextAdminUnsavedApplicantState(
  current: AdminUnsavedApplicantState | null,
  reported: AdminUnsavedApplicantState,
): AdminUnsavedApplicantState | null {
  if (reported.dirty) return reported;
  return current?.applicantId === reported.applicantId ? null : current;
}

export function adminUnsavedNavigationPrompt(state: AdminUnsavedApplicantState) {
  const description = `${state.applicantName ? `${state.applicantName}님의 ` : ""}투입·운영 정보가 저장되지 않았어요. 이동하면 변경 내용이 사라져요.`;
  const title = "저장하지 않은 변경이 있어요";
  return {
    title,
    description,
    cancelText: "계속 편집",
    confirmText: "변경 버리고 이동",
    nativeMessage: `${title}\n\n${description}`,
  };
}

export async function runAdminUnsavedNavigationTransition({
  dirtyApplicant,
  confirmDiscard,
  consumeDirty,
  restoreDirty,
  transition,
}: {
  dirtyApplicant: AdminUnsavedApplicantState | null;
  confirmDiscard: (state: AdminUnsavedApplicantState) => Promise<boolean>;
  consumeDirty: (state: AdminUnsavedApplicantState) => void;
  restoreDirty: (state: AdminUnsavedApplicantState) => void;
  transition: () => void | Promise<void>;
}): Promise<boolean> {
  if (dirtyApplicant && !(await confirmDiscard(dirtyApplicant))) return false;
  if (dirtyApplicant) consumeDirty(dirtyApplicant);

  try {
    await transition();
    return true;
  } catch (error) {
    if (dirtyApplicant) restoreDirty(dirtyApplicant);
    throw error;
  }
}
