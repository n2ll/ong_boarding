import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) test(`공고별 상담 원문과 연속 발언을 보존해 표시한다 (${width}px)`, async ({ page, context, baseURL }) => {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL! }]);
  await page.routeWebSocket("**/realtime/v1/**", () => {});
  await page.setViewportSize({ width, height: 900 });
  const at = new Date().toISOString();
  const attention = { state: "ready", items: [], totalCount: 0, truncated: false };
  const jobs = [
    { job_id: 11, title: "성수 오전 배송", branch: "성수", agent_stage: "screening", created_at: at, stage_updated_at: at },
    { job_id: 22, title: "강남 오후 배송", branch: "강남", agent_stage: null, created_at: at, stage_updated_at: at },
  ];
  const events = [
    { id: 1, job_id: 11, quote: "성수는 월요일 가능해요" },
    { id: 2, job_id: 11, quote: "성수는 수요일도 가능해요" },
    { id: 3, job_id: 22, quote: "강남은 주말 가능해요" },
  ].map(({ id, job_id, quote }) => ({ id, job_id, event_type: "job_consultation_observation", created_at: at,
    meta: { source: "inbound_sms", source_message_id: `m${id}`, observations: [{ kind: "availability", quote }] } }));
  const fixtures: Record<string, unknown> = {
    "/api/admin/applicants": { data: [{ id: 7, name: "상담검수", phone: "01000000000", status: "스크리닝 중", agent_stage: "screening", last_message_at: at, created_at: at, job_links: jobs }],
      previews: { 7: { body: "성수와 강남 모두 궁금해요", direction: "inbound", created_at: at, last_inbound_at: at } }, manual_message_attention: attention },
    "/api/admin/agent/handoffs": { handoffs: [] },
    "/api/admin/confirm/pending": { pending: [], total: 0 },
    "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: false }, items: [] },
    "/api/admin/agent/kill-switch": { mode: "draft", disabled: false, env_forced: false, updated_at: null },
    "/api/admin/applicants/7/active-jobs": { jobs },
    "/api/admin/messages/7": { messages: [], events, jobs: Object.fromEntries(jobs.map((j) => [j.job_id, j])), draft: null,
      agent_stage: "screening", access_token: null, manual_message_attention: attention,
      context_status: { reasoning: "ready", pool_events: "ready", job_labels: "ready" } },
  };
  const blocked: string[] = [];
  const errors: string[] = [];
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
    if (request.method() === "GET" && fixtures[url.pathname]) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(fixtures[url.pathname]) }); return;
    }
    blocked.push(`${request.method()} ${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  await page.goto("/live");
  await page.getByRole("button", { name: /^상 상담검수/ }).click();
  for (const event of events) {
    const title = jobs.find((job) => job.job_id === event.job_id)!.title;
    const label = page.getByText(`'${title}' 지원자 상담 발언 · 가용성: “${event.meta.observations[0].quote}”`);
    await label.scrollIntoViewIfNeeded();
    await expect(label).toBeVisible();
    const box = (await label.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
  }
  expect(errors).toEqual([]);
  expect(blocked).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: `/tmp/multi-job-consultation-${width}.png`, fullPage: true });
});
