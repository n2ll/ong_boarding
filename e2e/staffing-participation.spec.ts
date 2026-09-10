import { test, expect } from "@playwright/test";

for (const width of [1280, 390]) test(`실제 선탑·백업 참여를 기록하고 정정·삭제 이력을 보존한다 ${width}px`, async ({ page, baseURL }) => {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL! }]);
  await page.setViewportSize({ width, height: 844 });
  await page.routeWebSocket("**/*", () => {});
  const at = "2026-01-10T01:00:00Z";
  const applicant = { id: 1, name: "가상참여후보", phone: null, own_vehicle: null, status: "스크리닝 중" };
  const training = { status: "completed", backup_intent: "interested", scheduled_at: "2026-01-08T09:00:00+09:00", first_loading_location: "가상 교육장", linked_pro: "가상 프로" };
  const preparation = { source: "manager", dates: [{ date: "2026-09-15", availability: "available", role: "reserve_candidate" }], training_availability: "오전 가능", training, note: "기존 팀 메모", records: [] as Array<{ id: string; kind: string; date: string; note: string }> };
  const firstRevision = { event_id: 1, updated_at: at, invalid: false, actor: null, preparation };
  let snapshot = { ...firstRevision, applicant_id: 1, history: [firstRevision] };
  const writes: typeof preparation[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    if (path.endsWith("/staffing-preparation")) {
      if (request.method() === "GET") return route.fulfill({ json: { preparations: [snapshot], suggestions: [], primary_candidates: [], conflict_check_incomplete: false } });
      const body = request.postDataJSON();
      const saved = { ...preparation, dates: body.dates, training_availability: body.training_availability, training: body.training, note: body.note, records: body.records };
      writes.push(saved);
      const revision = { ...firstRevision, event_id: snapshot.event_id + 1, preparation: saved };
      snapshot = { ...revision, applicant_id: 1, history: [revision, ...snapshot.history] };
      return route.fulfill({ json: snapshot });
    }
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${path}`); return route.abort(); }
    const responses: Record<string, unknown> = {
      "/api/admin/jobs": { jobs: [{ id: 11, title: "가상 백업 라인", status: "active", recruit_mode: "internal", exposure: "targeted", counts: { sent: 1 }, interest_count: 0, created_at: at, capacity: 1 }] },
      "/api/admin/jobs/11/candidates": { candidates: [{ id: 1, applicant_id: 1, agent_stage: "exploration", sent_at: at, responded_at: at, applicants: applicant }], acquisition: { status: "error" } },
      "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] },
      "/api/admin/confirm/pending": { pending: [], total: 0 },
      "/api/admin/agent/kill-switch": { mode: "off", disabled: true, env_forced: false },
    };
    return route.fulfill({ json: responses[path] ?? { data: [] } });
  });
  await page.addInitScript(() => localStorage.setItem("ongboarding:staffing-author:v1", "가상매니저"));
  await page.goto("/jobs");
  await page.getByRole("button", { name: "전체 후보 1명", exact: true }).click();
  await page.getByRole("button", { name: "날짜별 배차 준비 펼치기" }).click();
  const edit = page.getByRole("button", { name: "가상참여후보 배차 준비 편집", exact: true });
  await edit.click();
  const editor = page.getByRole("dialog", { name: "가상참여후보 배차 준비", exact: true });
  await expect(editor.getByLabel("실제 참여 일자 1", { exact: true })).toHaveCount(0);
  await editor.getByRole("button", { name: "실제 참여 추가", exact: true }).click();
  await editor.getByLabel("실제 참여 일자 1", { exact: true }).fill("2026-01-08");
  await editor.getByLabel("참여 비고 1", { exact: true }).fill("동승 수행 확인");
  await editor.getByRole("button", { name: "실제 참여 추가", exact: true }).click();
  await editor.getByLabel("참여 종류 2", { exact: true }).selectOption("backup");
  await editor.getByLabel("실제 참여 일자 2", { exact: true }).fill("9999-01-01");
  await editor.getByRole("button", { name: "배차 준비 저장", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("실제 참여 일자는 오늘까지");
  expect(writes).toHaveLength(0);
  await editor.getByLabel("실제 참여 일자 2", { exact: true }).fill("2026-01-09");
  await editor.getByLabel("참여 비고 2", { exact: true }).fill("배송 수행 확인");
  await editor.getByLabel("참여 종류 1", { exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/ong-staffing-participation-${width}.png`, fullPage: true });
  await editor.getByRole("button", { name: "배차 준비 저장", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes[0].records.map(({ kind, date }) => ({ kind, date }))).toEqual([{ kind: "backup", date: "2026-01-09" }, { kind: "training", date: "2026-01-08" }]);
  const recordId = writes[0].records[0].id;
  await edit.click();
  await editor.getByLabel("실제 참여 일자 1", { exact: true }).fill("2026-01-10");
  await editor.getByLabel("참여 비고 1", { exact: true }).fill("실제 수행일 정정");
  await editor.getByRole("button", { name: "배차 준비 저장", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes[1].records[0]).toEqual({ id: recordId, kind: "backup", date: "2026-01-10", note: "실제 수행일 정정" });
  await edit.click();
  await editor.getByRole("button", { name: "참여 기록 2 삭제", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "실제 참여 기록을 삭제할까요?", exact: true });
  await confirmation.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(editor.getByLabel("실제 참여 일자 2", { exact: true })).toHaveCount(0);
  await editor.getByRole("button", { name: "배차 준비 저장", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await edit.click();
  const history = editor.locator("details").filter({ has: page.getByText("팀 변경 이력 4건", { exact: true }) });
  await history.locator("summary").click();
  await expect(history.getByText(/동승 수행 확인/).first()).toBeVisible();
  await expect(history.getByText(/배송 수행 확인/)).toBeVisible();
  expect(writes).toHaveLength(3);
  expect(writes[2].records).toHaveLength(1);
  for (const saved of writes) { expect(saved.dates).toEqual(preparation.dates); expect(saved.training).toEqual(training); expect(saved.note).toBe(preparation.note); }
  expect(unexpected).toEqual([]); expect(errors).toEqual([]);
});
