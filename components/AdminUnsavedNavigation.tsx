"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useRouter } from "next/navigation";
import {
  adminUnsavedNavigationPrompt,
  internalNavigationHrefForGuard,
  nextAdminUnsavedApplicantState,
  runAdminUnsavedNavigationTransition,
  type AdminUnsavedApplicantState,
} from "@/lib/admin/admin-unsaved-navigation";
import { useConfirm } from "./ConfirmDialog";

type NavigationTransition = () => void | Promise<void>;

type AdminUnsavedNavigationContextValue = {
  reportApplicantDirty: (state: AdminUnsavedApplicantState) => void;
  requestNavigation: (transition: NavigationTransition) => Promise<boolean>;
};

const AdminUnsavedNavigationContext = createContext<AdminUnsavedNavigationContextValue | null>(null);

export function useAdminUnsavedNavigation(): AdminUnsavedNavigationContextValue {
  const context = useContext(AdminUnsavedNavigationContext);
  if (!context) {
    throw new Error("useAdminUnsavedNavigation must be used within <AdminUnsavedNavigationProvider>");
  }
  return context;
}

export function AdminUnsavedNavigationProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const confirm = useConfirm();
  const dirtyApplicantRef = useRef<AdminUnsavedApplicantState | null>(null);
  const pendingNavigationRef = useRef(false);
  const recoveringPopStateRef = useRef(false);

  const reportApplicantDirty = useCallback((state: AdminUnsavedApplicantState) => {
    dirtyApplicantRef.current = nextAdminUnsavedApplicantState(dirtyApplicantRef.current, state);
  }, []);

  const requestNavigation = useCallback(async (transition: NavigationTransition): Promise<boolean> => {
    const dirtyApplicant = dirtyApplicantRef.current;
    const focusTarget = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const restoreFocus = () => requestAnimationFrame(() => focusTarget?.focus());
    if (dirtyApplicant && pendingNavigationRef.current) {
      restoreFocus();
      return false;
    }

    if (dirtyApplicant) pendingNavigationRef.current = true;
    try {
      const proceeded = await runAdminUnsavedNavigationTransition({
        dirtyApplicant,
        confirmDiscard: async (state) => {
          const prompt = adminUnsavedNavigationPrompt(state);
          return confirm({
            title: prompt.title,
            description: prompt.description,
            cancelText: prompt.cancelText,
            confirmText: prompt.confirmText,
            destructive: true,
          });
        },
        consumeDirty: (state) => {
          if (dirtyApplicantRef.current?.applicantId === state.applicantId) {
            dirtyApplicantRef.current = null;
          }
        },
        restoreDirty: (state) => {
          if (!dirtyApplicantRef.current) dirtyApplicantRef.current = state;
        },
        transition,
      });
      if (!proceeded) restoreFocus();
      return proceeded;
    } finally {
      if (dirtyApplicant) pendingNavigationRef.current = false;
    }
  }, [confirm]);

  useEffect(() => {
    const handleRootClick = (event: MouseEvent) => {
      if (!dirtyApplicantRef.current) return;
      const target = event.target;
      const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor) return;

      const href = internalNavigationHrefForGuard({
        currentHref: window.location.href,
        href: anchor.href,
        button: event.button,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        target: anchor.getAttribute("target"),
        download: anchor.hasAttribute("download"),
      });
      if (!href) return;

      event.preventDefault();
      event.stopPropagation();
      void requestNavigation(() => router.push(href));
    };

    document.addEventListener("click", handleRootClick, true);
    return () => document.removeEventListener("click", handleRootClick, true);
  }, [requestNavigation, router]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyApplicantRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (recoveringPopStateRef.current) {
        recoveringPopStateRef.current = false;
        return;
      }

      const dirtyApplicant = dirtyApplicantRef.current;
      if (!dirtyApplicant) return;
      if (window.confirm(adminUnsavedNavigationPrompt(dirtyApplicant).nativeMessage)) {
        dirtyApplicantRef.current = null;
        return;
      }

      // popstate는 이미 이동한 뒤 발생한다. 취소하면 즉시 앞 엔트리로 복구한다.
      event.stopImmediatePropagation();
      recoveringPopStateRef.current = true;
      window.history.forward();
    };

    window.addEventListener("popstate", handlePopState, true);
    return () => window.removeEventListener("popstate", handlePopState, true);
  }, []);

  const value = useMemo<AdminUnsavedNavigationContextValue>(() => ({
    reportApplicantDirty,
    requestNavigation,
  }), [reportApplicantDirty, requestNavigation]);

  return (
    <AdminUnsavedNavigationContext.Provider value={value}>
      {children}
    </AdminUnsavedNavigationContext.Provider>
  );
}

export type { AdminUnsavedApplicantState } from "@/lib/admin/admin-unsaved-navigation";
