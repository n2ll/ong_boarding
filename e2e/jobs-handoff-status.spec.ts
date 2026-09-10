import { expect, test } from "@playwright/test";

for (const scenario of [{ width: 1280, actionable: true }, { width: 390, actionable: false }]) {
  test(`공고 중지·완료·미해결 구분 ${scenario.width}px`, async ({ page, baseURL }) => {
    const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL! }]);
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await page.routeWebSocket("**/*", () => {});
    const at = "2026-01-02T00:00:00Z";
    const candidate = (id: number, name: string, state: unknown, reason = "문의 확인 필요", stage = "paused") => ({
      id, applicant_id: id, agent_stage: stage, paused_reason: reason, agent_state: state,
      sent_at: at, responded_at: at, closed_reason: null,
      applicants: { id, name, phone: null, status: "스크리닝 중", branch1: null, work_hours: null },
    });
    const completed = candidate(1, "완료후보", { meta: { handoff_resolved: { at } } });
    const held = candidate(2, "보관후보", {}, "매니저 수동 일시정지");
    const candidates = [completed, held, candidate(3, "대화후보", {}, "", "screening")];
    if (scenario.actionable) candidates.push(candidate(4, "재문의후보", { meta: {
      handoff_resolved: { at }, paused_at: "2026-01-03T00:00:00Z",
    } }));
    const original = JSON.stringify(candidates);
    const fixtures: Record<string, unknown> = {
      "/api/admin/jobs": { jobs: [{ id: 11, title: "가상 배송 라인", status: "active", recruit_mode: "internal", capacity: 2, created_at: at,
        counts: { paused: 2 + Number(scenario.actionable), screening: 1 },
        handoff_counts: { action_required: Number(scenario.actionable), intentional_pause: 1, resolved: 1 },
        interest_count: 0, review_ready_count: 0, confirmed_count: 0, tracking_submission_count: 0 }] },
      "/api/admin/jobs/11/candidates": { candidates, acquisition: { status: "error" } },
      "/api/admin/jobs/11/staffing-preparation": { preparations: [], suggestions: [], primary_candidates: [], conflict_check_incomplete: false },
      "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] },
      "/api/admin/confirm/pending": { pending: [], total: 0 },
      "/api/admin/agent/kill-switch": { mode: "off", disabled: true, env_forced: false },
      "/api/admin/clients": { data: [] },
      "/api/admin/branches": { data: [] },
      "/api/admin/site-managers": { data: [] },
    };
    const unexpected: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname === "cdn.jsdelivr.net" && url.pathname.endsWith("/pretendardvariable.min.css")) return route.fulfill({ contentType: "text/css", body: "" });
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) { unexpected.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (request.method() === "GET" && fixtures[url.pathname]) return route.fulfill({ json: fixtures[url.pathname] });
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    });
    await page.goto("/jobs");
    const summary = page.locator('section[aria-labelledby="jobs-operations-title"]').getByText("사람 확인", { exact: true }).locator("..");
    await expect(summary.locator("span").first()).toHaveText(String(Number(scenario.actionable)));
    await expect(page.getByText("인계 완료 1", { exact: true })).toBeVisible();
    await expect(page.getByText("중지 유지 1", { exact: true })).toBeVisible();
    await expect(page.getByText("대화 단계 1", { exact: true })).toBeVisible();
    await expect(page.getByText("AI 전역 중지됨", { exact: true })).toBeVisible();
    await expect(page.getByText(/AI 진행|자동 응대 진행 중/)).toHaveCount(0);
    await expect(page.getByText("사람 확인 1", { exact: true })).toHaveCount(Number(scenario.actionable));
    await page.getByRole("button", { name: `전체 후보 ${candidates.length}명`, exact: true }).click();
    await expect(page.getByText("인계 완료 · 중지 유지 1", { exact: true })).toBeVisible();
    await expect(page.getByText("중지 유지 1", { exact: true }).last()).toBeVisible();
    for (const row of candidates) await expect(page.getByText(row.applicants.name, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "응대 재개", exact: true })).toHaveCount(2 + Number(scenario.actionable));
    await expect(page.getByRole("link", { name: "새 답장 확인" })).toHaveAttribute("href", "/live");
    const board = page.getByRole("dialog", { name: "가상 배송 라인" });
    await expect.poll(async () => {
      const box = await board.boundingBox();
      return !!box && box.x >= 0 && box.x + box.width <= scenario.width + 1;
    }).toBe(true);
    if (scenario.width === 390) {
      const lastAction = board.getByRole("button", { name: "응대 재개", exact: true }).last();
      await lastAction.scrollIntoViewIfNeeded();
      await expect.poll(() => lastAction.evaluate(button => {
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
    }
    expect(JSON.stringify(candidates)).toBe(original);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/ong-jobs-handoff-${scenario.width}.png`, fullPage: true });
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}
