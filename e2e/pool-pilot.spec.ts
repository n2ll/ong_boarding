import { test, expect, type Page } from "@playwright/test";

const token = "11111111-1111-4111-8111-111111111111";
async function fixtures(page: Page) {
  let preferences: unknown = null;
  let mode: Record<string, unknown> = { mode: "off", disabled: true, env_forced: false };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    let response: unknown = { data: [] };
    if (path.endsWith("/preferences")) {
      if (request.method() === "POST") { preferences = request.postDataJSON(); writes.push({ path, body: request.postDataJSON() }); }
      response = { preferences, updated_at: preferences ? "2026-09-08T05:00:00Z" : null };
    } else if (path === `/api/pool/${token}`) response = { name: "가상 후보", jobs: [] };
    else if (path === "/api/admin/agent/kill-switch") {
      if (request.method() === "POST") {
        const body = request.postDataJSON(); writes.push({ path, body });
        mode = { mode: "off", disabled: true, env_forced: false, updated_at: "2026-09-10T04:00:00.000Z", pilot_session: body.action === "extend_pilot"
          ? { ...(mode.pilot_session as Record<string, unknown>), renewed_at: new Date().toISOString(), expires_at: new Date(Date.now() + body.duration_hours * 3600_000).toISOString() }
          : body.mode === "pilot" ? { mode: "pilot", applicant_ids: body.applicant_ids, job_ids: body.job_ids, started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() } : null };
      }
      response = mode;
    } else if (path === "/api/admin/jobs") response = { jobs: [{ id: 11, title: "가상 실제 모집 공고", status: "active" }] };
    else if (path === "/api/admin/agent/pilot-targets") response = { targets: [{ id: 7, name: "가상 후보", phone_suffix: "0000", job_ids: [11] }] };
    else if (path === "/api/admin/notifications") response = { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] };
    else if (path === "/api/admin/confirm/pending") response = { pending: [], total: 0 };
    else if (path === "/api/admin/agent/handoffs") response = { by_category: {}, total: 0 };
    else if (path === "/api/admin/agent/persona") response = { data: {} };
    else if (request.method() !== "GET") throw new Error(`Unexpected write: ${path}`);
    await route.fulfill({ json: response });
  });
  return writes;
}

test("모집 공고 없이 희망 조건 저장·수정·재방문, 모바일 가로 넘침 없음", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const writes = await fixtures(page);
  await page.goto(`/p/${token}`);
  await expect(page.getByRole("heading", { name: /지금은 준비된 일자리가 없어요/ })).toBeVisible();
  await page.getByRole("button", { name: "희망 조건 남기기" }).click();
  await page.getByLabel("휴무·결원 백업", { exact: true }).check();
  await page.getByLabel("활동 가능한 지역", { exact: true }).fill("성동구");
  await page.getByLabel("가능한 요일·시간", { exact: true }).fill("금요일 오후");
  await page.getByLabel("이용 가능한 차량", { exact: true }).fill("세단");
  await page.getByLabel("얼마나 미리 연락받으면 좋을까요? (선택)").fill("하루 전");
  await page.getByRole("button", { name: "희망 조건 저장" }).click();
  await expect(page.getByRole("button", { name: "희망 조건 수정" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "희망 조건 수정" }).click();
  await page.getByLabel("둘 다", { exact: true }).check();
  await page.getByRole("button", { name: "희망 조건 저장" }).click();
  await expect(page.getByRole("status")).toContainText("둘 다");
  expect(writes.map((write) => write.body.kind)).toEqual(["backup", "both"]);
  expect(writes.every((write) => write.path.endsWith("/preferences"))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/ong-pool-mobile.png", fullPage: true });
});

for (const width of [1280, 390]) test(`파일럿 명단·기간 확인 후 시작·같은 범위 연장·중단 ${width}px`, async ({ page, baseURL }) => {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL! }]);
  await page.routeWebSocket("**/*", () => {});
  await page.setViewportSize({ width, height: 844 });
  const writes = await fixtures(page);
  await page.goto("/brain?tab=mode");
  const panel = page.getByRole("region", { name: "파일럿 자동 응대" });
  const start = panel.getByRole("button", { name: "선택 대상 확인 후 시작" });
  await expect(start).toBeDisabled();
  await panel.getByLabel("가상 실제 모집 공고", { exact: true }).check();
  await panel.getByLabel("가상 후보 · 전화 끝 0000").check();
  await start.click();
  await expect(page.getByRole("alertdialog")).toContainText("가상 후보(끝 0000)");
  await expect(page.getByRole("alertdialog")).toContainText("1시간");
  await page.getByRole("button", { name: "제한 자동 응대 시작", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("선택 1명");
  await expect(panel.getByRole("button", { name: "기간 확인 후 연장" })).toBeVisible({ timeout: 2000 });
  await panel.getByLabel("연장 기간", { exact: true }).selectOption("336");
  await expect(panel.getByText(/연장 후 종료/)).toBeVisible();
  await panel.getByRole("button", { name: "기간 확인 후 연장" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("14일");
  await expect(page.getByRole("alertdialog")).toContainText("선택 1명·공고 1개");
  await page.getByRole("alertdialog").getByRole("button", { name: "기간 연장", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("선택 1명");
  await expect(page.getByText("같은 대상과 공고의 운영 기간을 연장했어요.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: `/tmp/ong-pilot-extension-panel-${width}.png` });
  await panel.getByRole("button", { name: "지금 중단" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "중단", exact: true }).click();
  await expect(start).toBeVisible();
  expect(writes.map((write) => write.body)).toEqual([{ mode: "pilot", job_ids: [11], applicant_ids: [7], duration_hours: 1 }, { action: "extend_pilot", duration_hours: 336, expected_updated_at: "2026-09-10T04:00:00.000Z" }, { mode: "off" }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: `/tmp/ong-pilot-panel-${width}.png` });
});
