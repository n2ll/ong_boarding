import { expect, test, type Page } from "@playwright/test";

async function installStatusFixtures(page: Page, baseURL: string, options: {
  target?: number; expired?: boolean; envForced?: boolean; failMode?: boolean; noSession?: boolean;
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
    "/api/admin/agent/kill-switch": { ...off, test_session: options.noSession ? null : { mode: "test", applicant_id: options.target ?? 7, job_ids: [11],
      started_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + (options.expired ? -1 : 1) * 600_000).toISOString() } },
    "/api/admin/applicants/7/active-jobs": { jobs },
    "/api/admin/messages/7": { messages: [], events: [], jobs: { 11: jobs[0] }, draft: null, agent_stage: "screening", access_token: null,
      manual_message_attention: attention, context_status: { reasoning: "ready", pool_events: "ready", job_labels: "ready" } },
    "/api/admin/branches": { data: [] },
    "/api/admin/jobs": { jobs: [{ id: 11, title: "상태 검수 배송", status: "active" }] },
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
      const payload = request.postDataJSON();
      fixtures[url.pathname] = payload.mode === "test" ? { ...off, test_session: {mode: "test", applicant_id: 7, job_ids: payload.job_ids,
        started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 20 * 60000).toISOString()} } : off;
      await route.fulfill({ json: fixtures[url.pathname] }); return;
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
  { width: 1280, active: true },
  { width: 390, active: true },
  { width: 390, active: false },
]) test(`운영 인계 보관 분리 (${scenario.width}px, 처리 필요 ${Number(scenario.active)}건)`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width: scenario.width, height: 900 });
  const state = await installStatusFixtures(page, baseURL!);
  const h = { candidate_id: 3, applicant_id: 7, job_id: 11, applicant_name: "상담검수", phone: "01000000000",
    job_title: "성수 배송", branch: "성수", reason: "공고별 답변 근거 확인 필요", category: "cross_job",
    category_label: "교차공고", tone: "human", suggested_action: "공고별 문의와 답변 내용을 대조해 주세요.",
    is_system_job: false, paused_at: new Date().toISOString(), age_days: 3 };
  const held = { ...h, candidate_id: 4, applicant_id: 8, applicant_name: "중지 유지 대상", category: "manual",
    category_label: "수동(매니저)", reason: "매니저 수동 일시정지", hold_label: "수동 중지",
    hold_reason: "관리자가 의도적으로 중지한 대화입니다.", age_days: 90 };
  await page.route("**/api/admin/agent/handoffs", route => route.fulfill({ json: {
    handoffs: scenario.active ? [h] : [], total: Number(scenario.active), held: [held], held_total: 1,
  } }));
  await page.goto("/live?tab=intervention");
  const badge = page.getByRole("tab", { name: `사람 확인 ${Number(scenario.active)}`, exact: true });
  await expect(badge).toBeVisible();
  const storage = page.getByRole("button", { name: "중지·검수 보관 1건", exact: true });
  await expect(storage).toBeVisible();
  await expect(page.getByRole("button", { name: "중지 유지 대상", exact: true })).toHaveCount(0);
  if (scenario.active) {
    await expect(page.getByText(h.suggested_action, { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "대화 확인", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "대기 답장 AI 처리", exact: true })).not.toBeVisible();
    await page.screenshot({ path: `/tmp/ong-handoff-active-${scenario.width}.png`, fullPage: true });
  } else {
    await expect(page.getByText("지금 처리할 인계가 없어요.", { exact: false })).toBeVisible();
  }
  await storage.click();
  await expect(storage).toHaveAttribute("aria-pressed", "true");
  await expect(badge).toBeVisible();
  await expect(page.getByRole("button", { name: "중지 유지 대상", exact: true })).toBeVisible();
  await expect(page.getByText(held.hold_reason, { exact: true })).toBeVisible();
  await expect(page.getByText(/90일 방치/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /대기 답장 AI 처리|이후 응대 재개|처리 완료/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = (await storage.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `/tmp/ong-handoff-held-${scenario.width}-${Number(scenario.active)}.png`, fullPage: true });
  await page.getByRole("button", { name: `처리 필요 ${Number(scenario.active)}건`, exact: true }).click();
  await expect(page.getByRole("button", { name: "중지 유지 대상", exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]);
  expect(state.blocked).toEqual([]);
  expect(state.writes).toEqual([]);
});

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

for (const width of [390, 1280]) test(`검수 시작은 공고 선택과 최종 확인이 필요하다 (${width})`, async ({page, baseURL}) => {
  await page.setViewportSize({width, height: 900});
  const state = await installStatusFixtures(page, baseURL!, {noSession: true});
  await page.goto("/brain?tab=mode");
  await expect(page.getByRole("radio", {name: /^자동 응대/})).toBeDisabled();
  const start = page.getByRole("button", {name: "20분 검수 시작"});
  await page.getByLabel("자동 응대 검수용 전화번호").fill("01000000000");
  await expect(start).toBeDisabled();
  await page.getByRole("checkbox", {name: "상태 검수 배송"}).check();
  await start.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("상태 검수 배송");
  await expect(dialog).toContainText("20분");
  expect(state.writes).toEqual([]);
  await dialog.getByRole("button", {name: "검수 시작", exact: true}).click();
  await expect(page.getByRole("status").filter({hasText: "선택 공고 1개만"})).toBeVisible();
  await expect(page.getByRole("button", {name: "검수 중단", exact: true})).toBeVisible();
  expect(await page.getByRole("tabpanel").evaluate((panel) => panel.getBoundingClientRect().width)).toBeGreaterThan(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(state.writes).toEqual([{mode: "test", phone: "01000000000", job_ids: [11]}]);
  expect(state.errors).toEqual([]);
  expect(state.blocked).toEqual([]);
  await page.screenshot({path: `/tmp/ong-containment-${width}.png`, fullPage: true});
});

test("대기 답장 처리와 이후 응대 재개를 구분하고 모바일에서 중복 클릭을 막는다", async ({ page, baseURL }) => {
  const state = await installStatusFixtures(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  const payloads: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = { candidate_id: 3, applicant_id: 7, job_id: 11, applicant_name: "상담검수", phone: "01000000000", job_title: "상태 검수 배송", branch: "성수",
    reason: "복수 공고 원문 검토", category: "cross_job", category_label: "공고별 상담", tone: "answerable", suggested_action: "대기 문자를 확인해 주세요.", is_system_job: false, paused_at: new Date().toISOString(), age_days: 0 };
  await page.route("**/api/admin/agent/handoffs", route => route.fulfill({ json: { handoffs: [h], total: 1 } }));
  await page.route("**/api/admin/agent/resume", async route => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) await gate;
    await route.fulfill({ json: { success: true, reply_sent: payloads.length === 1 } });
  });
  await page.goto("/live?tab=intervention");
  const reply = page.getByRole("button", { name: "대기 답장 AI 처리", exact: true });
  await page.getByText("응대·처리 옵션", { exact: true }).click();
  await expect(page.getByText(/대기 답장 AI 처리는 실제 문자를 발송합니다/)).toBeVisible();
  await reply.scrollIntoViewIfNeeded();
  await expect(reply).toBeVisible();
  await expect(reply).toBeInViewport();
  await reply.click();
  await expect(page.getByRole("button", { name: "처리 중…", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "이후 응대 재개", exact: true })).toBeDisabled();
  expect(payloads).toHaveLength(1);
  release();
  await expect(page.getByText("상담검수님 — 대기 문자에 AI가 답장했어요.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "이후 응대 재개", exact: true }).click();
  await expect(page.getByText("상담검수님 — 다음 수신 문자부터 AI가 응대해요.", { exact: true })).toBeVisible();
  expect(payloads).toEqual([{ applicant_id: 7, job_id: 11, reply_to_latest: true }, { applicant_id: 7, job_id: 11, reply_to_latest: false }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.errors).toEqual([]);
  expect(state.blocked).toEqual([]);
  await page.screenshot({ path: "/tmp/ong-pending-reply-mobile.png", fullPage: true });
});
