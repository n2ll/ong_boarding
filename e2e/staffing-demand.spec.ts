import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) test(`날짜별 수요를 저장하고 실패·충돌에서 입력을 보존한다 ${width}px`, async ({ page, baseURL }) => {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL! }]);
  await page.setViewportSize({ width, height: 844 });
  await page.routeWebSocket("**/*", () => {});
  const at = "2026-01-10T01:00:00Z", date = "2099-09-21", end = "2099-09-22";
  const job = { id: 11, title: "가상 배송 A", slot: "09:00~13:00", start_date: date, status: "active", recruit_mode: "internal", exposure: "targeted", counts: { sent: 1 }, interest_count: 0, created_at: at, capacity: 7 };
  type DemandEvent = { id: number; job_id: number; work_date: string; state: string; required_count: number | null; base_event_id: number | null; request_key: string; actor: { name: string; email: string }; created_at: string };
  let demand: DemandEvent | null = null;
  const latest: DemandEvent = { id: 31, job_id: 11, work_date: date, state: "operating", required_count: 6, base_event_id: null, request_key: "colleague-demand", actor: { name: "동료매니저", email: "consultation@example.test" }, created_at: at };
  const writes: Array<Record<string, unknown>> = [], boardRanges: string[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/admin/jobs/11/staffing-demand" && request.method() === "POST") {
      const body = request.postDataJSON();
      writes.push(body);
      if (width === 390 && writes.length === 1) return route.fulfill({ status: 503, json: { error: "수요 저장 연결 실패" } });
      if (width === 390 && writes.length === 2) {
        demand = latest;
        return route.fulfill({ status: 409, json: { error: "다른 매니저가 수요를 변경했습니다.", latest } });
      }
      demand = { id: (demand?.id ?? 100) + 1, job_id: 11, work_date: body.date, state: body.state, required_count: body.required_count, base_event_id: body.base_event_id,
        request_key: body.action_key, actor: { name: body.actor_name, email: "consultation@example.test" }, created_at: at };
      return route.fulfill({ json: { event: demand } });
    }
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === "/api/admin/staffing-date-board") {
      const start = url.searchParams.get("start"), requestedEnd = url.searchParams.get("end");
      boardRanges.push(`${start}/${requestedEnd}`);
      return route.fulfill({ json: { start, end: requestedEnd, updated_at: at, jobs: [{
        job_id: job.id, title: job.title, slot: job.slot, start_date: job.start_date, capacity: job.capacity,
        cells: [
          // Missing demand fields must remain unknown, even when the job has a capacity.
          { date, target: demand?.required_count ?? null, confirmed: 1, reserve: 1, primary: 1, shortage: demand?.state === "operating" ? Math.max(0, demand.required_count! - 1) : demand?.state === "off" ? 0 : null,
            invalid_records: 0, conflicts: [], ...(demand ? { demand_state: demand.state, demand_event_id: demand.id, invalid_demand: false } : {}) },
          { date: end, target: 3, confirmed: 0, reserve: 0, primary: 0, shortage: 3, invalid_records: 0, conflicts: [], demand_state: "operating", demand_event_id: 20, invalid_demand: false },
        ],
      }] } });
    }
    const fixtures: Record<string, unknown> = {
      "/api/admin/jobs": { jobs: [job] },
      "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] },
      "/api/admin/confirm/pending": { pending: [], total: 0 },
      "/api/admin/agent/kill-switch": { mode: "off", disabled: true, env_forced: false },
    };
    return route.fulfill({ json: fixtures[url.pathname] ?? { data: [] } });
  });
  await page.addInitScript(() => localStorage.setItem("ongboarding:staffing-author:v1", "가상매니저"));
  await page.goto("/jobs");
  await page.getByRole("button", { name: "날짜별 충원판", exact: true }).click();
  await page.getByLabel("충원 비교 시작일", { exact: true }).fill(date);
  await page.getByLabel("충원 비교 종료일", { exact: true }).fill(end);
  await expect.poll(() => boardRanges.includes(`${date}/${end}`)).toBe(true);
  const cell = page.getByRole("button", { name: `${job.title} ${date} 후보 확인`, exact: true });
  const otherDate = page.getByRole("button", { name: `${job.title} ${end} 후보 확인`, exact: true });
  await expect(cell).toContainText("수요 미정");
  await expect(cell).toContainText(/확정\s*1/);
  await expect(otherDate).toContainText(/필요\s*3/);
  const otherDateBefore = await otherDate.innerText();
  const edit = page.getByRole("button", { name: `${job.title} ${date} 수요 수정`, exact: true });
  await edit.click();
  const editor = page.getByRole("dialog", { name: `${job.title} ${date} 수요 설정`, exact: true });
  const state = editor.getByRole("combobox", { name: "운행 여부", exact: true });
  const count = editor.getByLabel("필요 인원", { exact: true });
  const author = editor.getByLabel("기록 작성자", { exact: true });
  const save = editor.getByRole("button", { name: "수요 저장", exact: true });
  await expect(state).toHaveValue("unknown");
  await state.selectOption("operating");
  await count.fill(width === 1280 ? "2" : "4");
  await author.fill("가상매니저");
  await save.click();

  if (width === 1280) {
    await expect(editor).not.toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ date, state: "operating", required_count: 2, base_event_id: null, actor_name: "가상매니저", action_key: expect.any(String) });
    await expect(cell).toContainText(/필요\s*2/);
    await expect(cell).toContainText(/확정\s*1/);
    await expect(cell).toContainText(/1명\s*부족|부족\s*1/);
    await expect(cell).toContainText(/예비 후보\s*1/);
    await expect(otherDate).toHaveText(otherDateBefore, { useInnerText: true });
    await edit.click();
    await expect(state).toHaveValue("operating");
    await expect(count).toHaveValue("2");
    await state.selectOption("off");
    await page.screenshot({ path: "/tmp/ong-staffing-demand-desktop.png" });
    await save.click();
    await expect(editor).not.toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ date, state: "off", required_count: 0, base_event_id: 101 });
    expect(writes[1].action_key).not.toBe(writes[0].action_key);
    await expect(cell).toContainText("운행 없음");
    await expect(cell).toContainText(/확정\s*1/);
    await expect(cell).toContainText(/재확인/);
  } else {
    await expect(editor.getByRole("alert")).toContainText("수요 저장 연결 실패");
    await expect(state).toHaveValue("operating");
    await expect(count).toHaveValue("4");
    await page.screenshot({ path: "/tmp/ong-staffing-demand-mobile.png" });
    await expect(author).toHaveValue("가상매니저");
    expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await save.click();
    await expect(editor.getByRole("alert")).toContainText("다른 매니저가 수요를 변경했습니다.");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ date, state: "operating", required_count: 4, base_event_id: null, actor_name: "가상매니저", action_key: expect.any(String) });
    expect(writes[1]).toEqual(writes[0]);
    await expect(count).toHaveValue("4");
    await editor.getByRole("button", { name: "최신 수요 불러오기", exact: true }).click();
    await expect(state).toHaveValue("operating");
    await expect(count).toHaveValue("6");
    await count.fill("5");
    await save.click();
    await expect(editor).not.toBeVisible();
    expect(writes).toHaveLength(3);
    expect(writes[2]).toMatchObject({ date, state: "operating", required_count: 5, base_event_id: 31 });
    expect(writes[2].action_key).not.toBe(writes[1].action_key);
    await expect(cell).toContainText(/필요\s*5/);
    await expect(cell).toContainText(/확정\s*1/);
    await expect(cell).toContainText(/4명\s*부족|부족\s*4/);
  }
  await expect(otherDate).toHaveText(otherDateBefore, { useInnerText: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(writes.every(write => write.date === date)).toBe(true);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
