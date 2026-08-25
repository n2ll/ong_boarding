import assert from "node:assert/strict";
import test from "node:test";

type DirtyState = {
  applicantId: number;
  applicantName?: string;
  dirty: boolean;
};

type NavigationIntent = {
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

type UnsavedNavigationModule = {
  internalNavigationHrefForGuard?: (intent: NavigationIntent) => string | null;
  nextAdminUnsavedApplicantState?: (
    current: DirtyState | null,
    reported: DirtyState,
  ) => DirtyState | null;
  adminUnsavedNavigationPrompt?: (state: DirtyState) => {
    title: string;
    description: string;
    cancelText: string;
    confirmText: string;
    nativeMessage: string;
  };
  runAdminUnsavedNavigationTransition?: (options: {
    dirtyApplicant: DirtyState | null;
    confirmDiscard: (state: DirtyState) => Promise<boolean>;
    consumeDirty: (state: DirtyState) => void;
    restoreDirty: (state: DirtyState) => void;
    transition: () => void | Promise<void>;
  }) => Promise<boolean>;
};

async function loadModule(): Promise<UnsavedNavigationModule> {
  try {
    return await import(new URL("./admin-unsaved-navigation.ts", import.meta.url).href) as UnsavedNavigationModule;
  } catch {
    return {};
  }
}

test("an ordinary same-origin left click resolves to an internal router destination", async () => {
  const { internalNavigationHrefForGuard } = await loadModule();
  assert.equal(typeof internalNavigationHrefForGuard, "function");

  assert.equal(
    internalNavigationHrefForGuard!({
      currentHref: "https://admin.ongboarding.test/pipeline?q=kim",
      href: "https://admin.ongboarding.test/jobs?new=1#form",
      button: 0,
    }),
    "/jobs?new=1#form",
  );
});

test("non-SPA and explicit alternate click intents bypass the unsaved guard", async () => {
  const { internalNavigationHrefForGuard } = await loadModule();
  assert.equal(typeof internalNavigationHrefForGuard, "function");

  const currentHref = "https://admin.ongboarding.test/pipeline?q=kim#profile";
  const bypasses: NavigationIntent[] = [
    { currentHref, href: "https://example.com/jobs" },
    { currentHref, href: "tel:01012345678" },
    { currentHref, href: "mailto:manager@example.com" },
    { currentHref, href: "/jobs", button: 1 },
    { currentHref, href: "/jobs", metaKey: true },
    { currentHref, href: "/jobs", ctrlKey: true },
    { currentHref, href: "/jobs", shiftKey: true },
    { currentHref, href: "/jobs", altKey: true },
    { currentHref, href: "/jobs", target: "_blank" },
    { currentHref, href: "/jobs", download: true },
    { currentHref, href: "/pipeline?q=kim#jobs" },
    { currentHref, href: currentHref },
  ];

  for (const intent of bypasses) {
    assert.equal(internalNavigationHrefForGuard!(intent), null, JSON.stringify(intent));
  }
});

test("a query change on the same pathname is navigation, not a hash-only bypass", async () => {
  const { internalNavigationHrefForGuard } = await loadModule();
  assert.equal(typeof internalNavigationHrefForGuard, "function");

  assert.equal(
    internalNavigationHrefForGuard!({
      currentHref: "https://admin.ongboarding.test/pipeline?q=kim#profile",
      href: "/pipeline?q=lee#profile",
    }),
    "/pipeline?q=lee#profile",
  );
});

test("a stale clean report cannot clear another applicant's active draft", async () => {
  const { nextAdminUnsavedApplicantState } = await loadModule();
  assert.equal(typeof nextAdminUnsavedApplicantState, "function");

  const current = { applicantId: 22, applicantName: "이영희", dirty: true };
  assert.deepEqual(
    nextAdminUnsavedApplicantState!(current, { applicantId: 11, dirty: false }),
    current,
  );
  assert.equal(
    nextAdminUnsavedApplicantState!(current, { applicantId: 22, dirty: false }),
    null,
  );
});

test("custom and native prompts share the existing warning copy and explicit discard CTA", async () => {
  const { adminUnsavedNavigationPrompt } = await loadModule();
  assert.equal(typeof adminUnsavedNavigationPrompt, "function");

  assert.deepEqual(
    adminUnsavedNavigationPrompt!({ applicantId: 22, applicantName: "이영희", dirty: true }),
    {
      title: "저장하지 않은 변경이 있어요",
      description: "이영희님의 투입·운영 정보가 저장되지 않았어요. 이동하면 변경 내용이 사라져요.",
      cancelText: "계속 편집",
      confirmText: "변경 버리고 이동",
      nativeMessage: "저장하지 않은 변경이 있어요\n\n이영희님의 투입·운영 정보가 저장되지 않았어요. 이동하면 변경 내용이 사라져요.",
    },
  );
});

test("a confirmed navigation that throws restores the consumed dirty applicant", async () => {
  const { runAdminUnsavedNavigationTransition } = await loadModule();
  assert.equal(typeof runAdminUnsavedNavigationTransition, "function");

  const dirtyApplicant = { applicantId: 22, applicantName: "이영희", dirty: true };
  const consumed: DirtyState[] = [];
  const restored: DirtyState[] = [];

  await assert.rejects(
    runAdminUnsavedNavigationTransition!({
      dirtyApplicant,
      confirmDiscard: async () => true,
      consumeDirty: (state) => consumed.push(state),
      restoreDirty: (state) => restored.push(state),
      transition: () => {
        throw new Error("navigation failed");
      },
    }),
    /navigation failed/,
  );

  assert.deepEqual(consumed, [dirtyApplicant]);
  assert.deepEqual(restored, [dirtyApplicant]);
});
