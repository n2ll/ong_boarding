import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path: string) => readFile(new URL(path, root), "utf8");

test("the admin navigation boundary is inside ConfirmProvider and owns root navigation capture", async () => {
  const [layout, boundary] = await Promise.all([
    source("app/(admin)/layout.tsx"),
    source("components/AdminUnsavedNavigation.tsx").catch(() => ""),
  ]);

  const confirmOpen = layout.indexOf("<ConfirmProvider>");
  const boundaryOpen = layout.indexOf("<AdminUnsavedNavigationProvider>");
  const boundaryClose = layout.indexOf("</AdminUnsavedNavigationProvider>");
  const confirmClose = layout.indexOf("</ConfirmProvider>");

  assert.ok(confirmOpen >= 0 && confirmOpen < boundaryOpen, "navigation provider must use the existing custom confirm context");
  assert.ok(boundaryOpen < boundaryClose && boundaryClose < confirmClose, "navigation provider must stay inside ConfirmProvider");
  assert.match(boundary, /document\.addEventListener\("click",\s*handleRootClick,\s*true\)/);
  assert.match(boundary, /window\.addEventListener\("popstate",\s*handlePopState,\s*true\)/);
  assert.match(boundary, /window\.addEventListener\("beforeunload",\s*handleBeforeUnload\)/);
  assert.match(boundary, /window\.history\.forward\(\)/);
  assert.match(boundary, /if \(!proceeded\) restoreFocus\(\)/);
});

test("Sidebar logout and every Topbar router push run through requestNavigation", async () => {
  const [sidebar, topbar] = await Promise.all([
    source("components/Sidebar.tsx"),
    source("components/Topbar.tsx"),
  ]);

  assert.match(sidebar, /useAdminUnsavedNavigation\(\)/);
  assert.match(sidebar, /requestNavigation\(performSignOut\)/);

  assert.match(topbar, /useAdminUnsavedNavigation\(\)/);
  assert.match(topbar, /requestNavigation\(\(\) => \{/);
  assert.equal(
    (topbar.match(/router\.push\(/g) ?? []).length,
    1,
    "Topbar should have one guarded router.push implementation rather than unguarded call sites",
  );
});
