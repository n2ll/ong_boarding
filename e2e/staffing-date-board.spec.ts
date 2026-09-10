import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) test(`날짜별 충원판에서 확정·예비와 확인할 일을 구분한다 ${width}px`, async ({ page, baseURL }) => {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL! }]);
  await page.setViewportSize({ width, height: 844 });
  await page.routeWebSocket("**/*", () => {});
  const at = "2026-01-10T01:00:00Z";
  const date = "2099-09-21", end = "2099-09-23";
  const jobs = [
    { id: 11, title: "가상 배송 A", slot: "09:00~13:00", start_date: date, status: "active", recruit_mode: "internal", exposure: "targeted", counts: { sent: 1 }, interest_count: 0, created_at: at, capacity: 1 },
    { id: 12, title: "가상 배송 B", slot: "14:00~18:00", start_date: date, status: "active", recruit_mode: "internal", exposure: "targeted", counts: {}, interest_count: 0, created_at: at, capacity: 0 },
  ];
  const applicant = { id: 1, name: "가상후보1", phone: null, own_vehicle: null, status: "스크리닝 중" };
  const preparation = {
    source: "manager", dates: [{ date, availability: "available", role: "primary_candidate", confirmation: "unconfirmed" }],
    training_availability: "", training: { status: "completed", backup_intent: "interested", scheduled_at: "", first_loading_location: "", linked_pro: "" },
    note: "", records: [],
  };
  const firstRevision = { event_id: 1, updated_at: at, invalid: false, actor: null, preparation };
  let snapshot = { ...firstRevision, applicant_id: 1, history: [firstRevision] };
  let boardUnavailable = false;
  const writes: Array<Record<string, unknown>> = [], boardRanges: string[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/admin/jobs/11/staffing-preparation") {
      if (request.method() === "GET") return route.fulfill({ json: { preparations: [snapshot], suggestions: [], primary_candidates: [], conflict_check_incomplete: false } });
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        writes.push(body);
        const saved = { ...preparation, dates: body.dates, training_availability: body.training_availability, training: body.training, note: body.note, records: body.records };
        const revision = { ...firstRevision, event_id: snapshot.event_id + 1, preparation: saved };
        snapshot = { ...revision, applicant_id: 1, history: [revision, ...snapshot.history] };
        return route.fulfill({ json: snapshot });
      }
    }
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === "/api/admin/staffing-date-board") {
      const start = url.searchParams.get("start"), requestedEnd = url.searchParams.get("end");
      boardRanges.push(`${start}/${requestedEnd}`);
      if (boardUnavailable) return route.fulfill({ status: 503, json: { error: "충원판 조회 실패" } });
      const confirmed = width === 390 || writes.length > 0 ? 1 : 0;
      return route.fulfill({ json: { start, end: requestedEnd, updated_at: at, jobs: jobs.map(job => ({
        job_id: job.id, title: job.title, slot: job.slot, start_date: job.start_date, capacity: job.capacity,
        cells: [date, "2099-09-22", end].map((cellDate) => ({ date: cellDate, target: job.id === 11 ? 1 : null, confirmed: job.id === 11 && cellDate === date ? confirmed : 0,
          reserve: job.id === 11 && cellDate === date ? 1 : 0, primary: job.id === 11 && cellDate === date ? 1 : 0,
          shortage: job.id === 11 ? 1 - (cellDate === date ? confirmed : 0) : null, invalid_records: 0,
          conflicts: width === 390 && job.id === 11 && cellDate === date ? [{ applicant_id: 1, name: "가상후보1", other_job_id: 12, other_job_title: "가상 배송 B" }] : [],
        })),
      })) } });
    }
    const fixtures: Record<string, unknown> = {
      "/api/admin/jobs": { jobs },
      "/api/admin/jobs/11/candidates": { candidates: [{ id: 1, applicant_id: 1, agent_stage: "exploration", sent_at: at, responded_at: at, applicants: applicant }], acquisition: { status: "error" } },
      "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] },
      "/api/admin/confirm/pending": { pending: [], total: 0 },
      "/api/admin/agent/kill-switch": { mode: "off", disabled: true, env_forced: false },
    };
    return route.fulfill({ json: fixtures[url.pathname] ?? { data: [] } });
  });
  await page.addInitScript(() => localStorage.setItem("ongboarding:staffing-author:v1", "가상매니저"));
  await page.goto("/jobs");
  const openBoard = page.getByRole("button", { name: "날짜별 충원판", exact: true });
  await expect(openBoard).toBeVisible();
  await openBoard.click();
  await page.getByLabel("충원 비교 시작일", { exact: true }).fill(date);
  await page.getByLabel("충원 비교 종료일", { exact: true }).fill(end);
  await expect.poll(() => boardRanges.includes(`${date}/${end}`)).toBe(true);
  const cell = page.getByRole("button", { name: `가상 배송 A ${date} 후보 확인`, exact: true });
  const unsetTarget = page.getByRole("button", { name: `가상 배송 B ${date} 후보 확인`, exact: true });
  await expect(cell).toContainText(new RegExp(`확정\\s*${width === 390 ? 1 : 0}`));
  await expect(cell).toContainText(/예비 후보\s*1/);
  await expect(unsetTarget).toContainText("모집목표 미정");

  if (width === 1280) {
    await cell.click();
    const candidates = page.getByRole("dialog", { name: "가상 배송 A", exact: true });
    await expect(candidates.getByRole("button", { name: /날짜별 배차 준비/ })).toHaveAttribute("aria-expanded", "true");
    await expect(candidates.getByLabel("비교할 날짜", { exact: true })).toHaveValue(date);
    await candidates.getByRole("button", { name: "가상후보1 배차 준비 편집", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "가상후보1 배차 준비", exact: true });
    await editor.getByLabel("날짜별 투입 확정 1", { exact: true }).check();
    await editor.getByRole("button", { name: "배차 준비 저장", exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "날짜별 투입을 확정할까요?", exact: true });
    await expect(confirmation).toBeVisible();
    expect(writes).toHaveLength(0);
    await confirmation.getByRole("button", { name: "확정하고 저장", exact: true }).click();
    await expect(editor).not.toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ applicant_id: 1, confirmation_version: 1, dates: [{ date, availability: "available", role: "primary_candidate", confirmation: "confirmed" }] });
    await candidates.getByRole("button", { name: "지원자 보드 닫기", exact: true }).click();
    await expect(candidates).not.toBeVisible();
    await expect(cell).toContainText(/확정\s*1/);
    await expect(cell).toContainText(/예비 후보\s*1/);
  } else {
    await expect(cell).toContainText("같은 날 다른 라인에도 확정");
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("region", { name: "날짜별 충원 현황", exact: true }).evaluate(element => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: `/tmp/ong-staffing-date-board-${width}.png`, fullPage: true });
  if (width === 390) {
    boardUnavailable = true;
    await page.getByRole("button", { name: "충원판 새로고침", exact: true }).click();
    await expect(page.getByRole("region", { name: "날짜별 충원 현황", exact: true }).getByRole("alert")).toContainText("충원판 조회 실패");
    await expect(cell).toBeHidden();
    await expect(unsetTarget).toBeHidden();
    expect(writes).toHaveLength(0);
  }
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
