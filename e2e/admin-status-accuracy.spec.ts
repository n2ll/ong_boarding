import { expect, test, type Page } from "@playwright/test";

async function installStatusFixtures(page: Page, baseURL: string, options: {
  target?: number; expired?: boolean; envForced?: boolean; failMode?: boolean;
} = {}) {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL }]);
  await page.routeWebSocket("**/realtime/v1/**", () => {});
  const at = new Date().toISOString();
  const attention = { state: "ready", items: [], totalCount: 0, truncated: false };
  const jobs = [{ job_id: 11, title: "상태 검수 배송", branch: "성수", agent_stage: "screening", created_at: at, stage_updated_at: at }];
  const off = { mode: "off", disabled: true, env_forced: options.envForced ?? false };
  const fixtures: Record<string, unknown> = {
    "/api/admin/applicants": { data: [{ id: 7, name: "상담검수", phone: "01000000000", status: "스크리닝 중", agent_stage: "screening", last_message_at: at, created_at: at, job_links: jobs }],
      previews: { 7: { body: "방금 보낸 답장", direction: "inbound", created_at: at, last_inbound_at: at } }, manual_message_attention: attention },
    "/api/admin/agent/handoffs": { handoffs: [], by_category: {}, total: 0 },
    "/api/admin/confirm/pending": { pending: [], total: 0 },
    "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] },
    "/api/admin/agent/kill-switch": { ...off, test_session: { mode: "test", applicant_id: options.target ?? 7,
      started_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + (options.expired ? -1 : 1) * 600_000).toISOString() } },
    "/api/admin/applicants/7/active-jobs": { jobs },
    "/api/admin/messages/7": { messages: [], events: [], jobs: { 11: jobs[0] }, draft: null, agent_stage: "screening", access_token: null,
      manual_message_attention: attention, context_status: { reasoning: "ready", pool_events: "ready", job_labels: "ready" } },
    "/api/admin/branches": { data: [] },
    "/api/admin/jobs": { jobs: [] },
    "/api/admin/prompt-examples": { data: [] },
    "/api/admin/usage": {},
    "/api/admin/agent/persona": { data: {} },
  };
  const blocked: string[] = [];
  const errors: string[] = [];
  const writes: unknown[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "cdn.jsdelivr.net" && url.pathname.endsWith("/pretendardvariable.min.css")) {
      await route.fulfill({ contentType: "text/css", body: "" }); return;
    }
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
      blocked.push(url.origin); await route.abort("blockedbyclient"); return;
    }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    if (url.pathname === "/api/admin/agent/kill-switch" && request.method() === "POST") {
      writes.push(request.postDataJSON());
      fixtures[url.pathname] = off;
      await route.fulfill({ json: off }); return;
    }
    if (request.method() === "GET" && fixtures[url.pathname]) {
      await route.fulfill({ status: options.failMode && url.pathname.endsWith("/kill-switch") ? 503 : 200, json: fixtures[url.pathname] }); return;
    }
    blocked.push(`${request.method()} ${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  return { blocked, errors, writes };
}

for (const scenario of [
  { name: "검수 대상", options: {}, text: "이 지원자는 자동 응대 검수 대상" },
  { name: "일반 지원자", options: { target: 8 }, text: "이 지원자 AI 중지됨" },
  { name: "검수 만료", options: { expired: true }, text: "AI 전역 중지됨" },
  { name: "환경 강제 중지", options: { envForced: true }, text: "AI 전역 중지됨" },
  { name: "조회 실패", options: { failMode: true }, text: "AI 모드 확인 불가" },
]) test(`상담 배너: ${scenario.name}`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const state = await installStatusFixtures(page, baseURL!, scenario.options);
  await page.goto("/live");
  await page.getByRole("button", { name: /^상 상담검수/ }).click();
  await expect(page.getByText(scenario.text, { exact: false }).first()).toBeVisible();
  if (scenario.name === "검수 대상") {
    await expect(page.getByRole("status").filter({ hasText: "테스트 1명만 자동 응대" })).toBeVisible();
    await expect(page.getByText(/AI 전역 중지됨/)).toHaveCount(0);
    await page.screenshot({ path: "/tmp/admin-status-conversation-mobile.png", fullPage: true });
  }
  expect(state.errors).toEqual([]);
  expect(state.blocked).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("두뇌 요약과 검수 중단 확인이 제한 범위를 설명한다", async ({ page, baseURL }) => {
  const state = await installStatusFixtures(page, baseURL!);
  await page.goto("/brain?tab=mode");
  const summary = page.getByRole("link").filter({ hasText: "전역 응답 모드" });
  await expect(summary).toContainText("테스트 1명만 자동 응대");
  await expect(page.getByRole("radio", { name: /완전 중지/ })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "검수 중단", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("자동 응대 검수를 중단할까요?");
  await expect(dialog).toContainText("일반 지원자는 계속 중지 상태입니다.");
  await page.screenshot({ path: "/tmp/admin-status-stop-dialog.png", fullPage: true, animations: "disabled" });
  await dialog.getByRole("button", { name: "검수 중단", exact: true }).click();
  await expect(summary).toContainText("완전 중지");
  expect(state.writes).toEqual([{ mode: "off" }]);
  expect(state.errors).toEqual([]);
  expect(state.blocked).toEqual([]);
});

test.describe("문자 입력창 반응형 검수", () => {
  test.use({ hasTouch: true });
  for (const viewport of [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 768, height: 900 },
    { width: 1280, height: 900 },
  ]) test(`문자 발송 버튼은 메뉴에 가리지 않고 한 번만 발송한다 (${viewport.width}px)`, async ({ page, baseURL }) => {
    await page.setViewportSize(viewport);
    const state = await installStatusFixtures(page, baseURL!, { target: 8 });
    const sent: unknown[] = [];
    await page.route("**/api/admin/messages/send", async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: { success: true, status: "sent", paused: true } });
    });
    await page.goto("/live");
    await page.getByRole("button", { name: /^상 상담검수/ }).click();
    const input = page.getByRole("textbox", { name: "지원자에게 보낼 문자" });
    await input.fill("로컬 버튼 검수");
    const send = page.getByRole("button", { name: /^문자(만)? 발송$/ });
    await expect(send).toBeEnabled();
    await send.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/sms-composer-${viewport.width}.png`, animations: "disabled" });
    const inputBox = (await input.boundingBox())!;
    expect(inputBox.width).toBeGreaterThanOrEqual(Math.min(280, viewport.width - 64));
    const box = (await send.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(await send.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    // 실제 좌표를 눌러 고정 메뉴가 클릭을 가로채는지도 확인한다.
    if (viewport.width === 390) {
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ applicant_id: 7, job_id: 11, body: "로컬 버튼 검수" });
    await expect(input).toHaveValue("");
    await expect(page).toHaveURL(/\/live$/);
    expect(state.errors).toEqual([]);
    expect(state.blocked).toEqual([]);
    expect(state.writes).toEqual([]);
  });
});
