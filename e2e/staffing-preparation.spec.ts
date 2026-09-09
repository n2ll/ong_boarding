import { test, expect } from "@playwright/test";

test("연결 후보와 관심 구분, 날짜별 준비 저장 실패 재시도와 모바일 편집", async ({ page }) => {
  test.setTimeout(60_000);
  const at = "2026-09-09T07:00:00Z";
  const candidates = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, applicant_id: i + 1, agent_stage: null, sent_at: at, responded_at: null, applicants: { id: i + 1, name: `가상후보${i + 1}`, own_vehicle: null, status: "스크리닝 중" } }));
  let preparations: unknown[] = [];
  let candidateReads = 0;
  let finishFailedRefresh = () => {};
  const refreshGate = new Promise<void>((resolve) => { finishFailedRefresh = resolve; });
  const writes: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    if (path.endsWith("/candidates") && ++candidateReads > 1) {
      await refreshGate;
      return route.fulfill({ status: 503, json: { error: "fixture candidate refresh failure" } });
    }
    if (path.endsWith("/staffing-preparation")) {
      if (request.method() === "GET") return route.fulfill({ json: { preparations } });
      const body = request.postDataJSON(); writes.push(body);
      if (writes.length === 1) return route.abort("failed");
      const saved = { applicant_id: body.applicant_id, preparation: { source: "manager", dates: body.dates, training_availability: body.training_availability, note: body.note }, event_id: 1, updated_at: at, invalid: false };
      preparations = [saved];
      return route.fulfill({ json: { ...saved, deduplicated: true } });
    }
    if (request.method() !== "GET") { unexpected.push(path); return route.abort(); }
    const responses: Record<string, unknown> = {
      "/api/admin/jobs": { jobs: [{ id: 11, title: "가상 예비 백업 배송", status: "active", recruit_mode: "internal", exposure: "targeted", counts: { sent: 50 }, interest_count: 0, created_at: at, capacity: 1 }] },
      "/api/admin/jobs/11/candidates": { candidates, acquisition: { status: "error" } },
      "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] },
      "/api/admin/confirm/pending": { pending: [], total: 0 },
      "/api/admin/agent/kill-switch": { mode: "off", disabled: true, env_forced: false },
    };
    return route.fulfill({ json: responses[path] ?? { data: [] } });
  });
  await page.goto("/jobs");
  await page.getByRole("button", { name: "전체 후보 50명", exact: true }).click();
  await expect(page.getByText("연결 후보 50명 · 관심 표시 0명", { exact: true })).toBeVisible();
  await expect(page.getByText("50명 지원", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "날짜별 배차 준비 펼치기" }).click();
  await page.getByLabel("비교할 날짜", { exact: true }).fill("2026-09-22");
  await page.getByRole("button", { name: "가상후보1 배차 준비 편집", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "가상후보1 배차 준비", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("후보 역할 1")).toBeDisabled();
  await dialog.getByLabel("가능 여부 1").selectOption("available");
  await dialog.getByLabel("후보 역할 1").selectOption("reserve_candidate");
  await dialog.getByLabel("가능 여부 1").selectOption("unavailable");
  await expect(dialog.getByLabel("후보 역할 1")).toHaveValue("unassigned");
  await dialog.getByLabel("가능 여부 1").selectOption("available");
  await dialog.getByLabel("후보 역할 1").selectOption("reserve_candidate");
  await dialog.getByLabel("선탑 가능 시간", { exact: true }).fill("9/16 오전 가능, 시간 조율 필요");
  await dialog.getByLabel("관리자 메모").fill("지원자 답장 확인 후 정리");
  await dialog.getByRole("button", { name: "배차 준비 저장" }).click();
  await expect(dialog.getByRole("alert")).toContainText("입력 내용은 유지됩니다");
  await expect(dialog.getByLabel("선탑 가능 시간", { exact: true })).toHaveValue("9/16 오전 가능, 시간 조율 필요");
  await dialog.getByRole("button", { name: "배차 준비 저장" }).click();
  await expect(page.getByRole("dialog").filter({ hasText: "관리자가 확인한 내용을 기록합니다." })).not.toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[0].action_key).toBe(writes[1].action_key);
  await expect(page.getByText("2026-09-22 · 가능 1명 · 본담당 후보 0명 · 예비 후보 1명", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/ong-staffing-preparation-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "지원서 다시 확인", exact: true }).click();
  await expect.poll(() => candidateReads).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "가상후보1 배차 준비 편집", exact: true }).click();
  await expect(dialog.getByLabel("날짜 1", { exact: true })).toHaveValue("2026-09-22");
  await expect(dialog.getByLabel("후보 역할 1")).toHaveValue("reserve_candidate");
  const button = dialog.getByRole("button", { name: "배차 준비 저장" });
  await expect(button).toBeInViewport();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/ong-staffing-preparation-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByLabel("관리자 메모").fill("저장 전 변경");
  const failedRefresh = page.waitForResponse((response) => response.url().endsWith("/candidates") && response.status() === 503);
  finishFailedRefresh();
  await failedRefresh;
  await expect(dialog.getByLabel("관리자 메모")).toHaveValue("저장 전 변경");
  await page.keyboard.press("Escape");
  await expect(page.getByText("저장하지 않은 변경이 있어요", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});
