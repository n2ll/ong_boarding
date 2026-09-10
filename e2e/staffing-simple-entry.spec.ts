import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) test(`진행 기록 종류를 바꿔도 초안과 기존 투입 확정을 보존한다 ${width}px`, async ({ page, baseURL }) => {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL! }]);
  await page.setViewportSize({ width, height: 844 });
  await page.routeWebSocket("**/*", () => {});
  const at = "2026-01-10T01:00:00Z";
  const preparation = {
    source: "manager",
    dates: [{ date: "2099-09-21", availability: "available", role: "primary_candidate", confirmation: "confirmed" }],
    training_availability: "오전 가능",
    training: { status: "coordinating", backup_intent: "unknown", scheduled_at: "2020-01-08T09:00:00+09:00", first_loading_location: "가상 교육장", linked_pro: "가상 프로" },
    records: [{ id: "00000000-0000-4000-8000-000000000001", kind: "backup", date: "2020-01-08", note: "기존 실제 참여" }],
    note: "기존 팀 메모", follow_up: null,
  };
  const firstRevision = { event_id: 1, updated_at: at, invalid: false, actor: null, preparation };
  let snapshot = { ...firstRevision, applicant_id: 1, history: [firstRevision] };
  const writes: Array<Record<string, unknown>> = [], unexpected: string[] = [], errors: string[] = [];
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
        const saved = { ...preparation, dates: body.dates, training_availability: body.training_availability, training: body.training, records: body.records, note: body.note, follow_up: body.follow_up };
        const revision = { ...firstRevision, event_id: snapshot.event_id + 1, preparation: saved };
        snapshot = { ...revision, applicant_id: 1, history: [revision, ...snapshot.history] };
        return route.fulfill({ json: snapshot });
      }
    }
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    const fixtures: Record<string, unknown> = {
      "/api/admin/jobs": { jobs: [{ id: 11, title: "가상 배송 라인", status: "active", recruit_mode: "internal", exposure: "targeted", counts: { sent: 1 }, interest_count: 0, created_at: at, capacity: 1 }] },
      "/api/admin/jobs/11/candidates": { candidates: [{ id: 1, applicant_id: 1, agent_stage: "exploration", sent_at: at, responded_at: at, applicants: { id: 1, name: "가상후보1", phone: null, own_vehicle: null, status: "스크리닝 중" } }], acquisition: { status: "error" } },
      "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] },
      "/api/admin/confirm/pending": { pending: [], total: 0 },
      "/api/admin/agent/kill-switch": { mode: "off", disabled: true, env_forced: false },
    };
    return route.fulfill({ json: fixtures[url.pathname] ?? { data: [] } });
  });
  await page.addInitScript(() => localStorage.setItem("ongboarding:staffing-author:v1", "가상매니저"));
  await page.goto("/jobs");
  await page.getByRole("button", { name: "전체 후보 1명", exact: true }).click();
  await page.getByRole("button", { name: "날짜별 배차 준비 펼치기" }).click();
  await page.getByLabel("비교할 날짜", { exact: true }).fill("2099-09-22");
  const edit = page.getByRole("button", { name: "가상후보1 진행 기록", exact: true });
  await edit.click();
  const editor = page.getByRole("dialog", { name: "가상후보1 진행 기록", exact: true });
  await expect(editor.getByRole("combobox", { name: "선탑 진행 상태", exact: true })).toBeHidden();
  await expect(editor.getByRole("button", { name: "실제 참여 추가", exact: true })).toBeHidden();
  await expect(editor.getByLabel("날짜 1", { exact: true })).toBeHidden();
  await editor.getByRole("button", { name: "연락 기록 추가", exact: true }).click();
  await editor.getByLabel("최근 연락 일자", { exact: true }).fill("2020-01-09");
  await editor.getByRole("textbox", { name: "연락 결과", exact: true }).fill("선탑 실제 참여를 전화로 확인함");
  await editor.getByRole("button", { name: "선탑 진행", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "연락 결과", exact: true })).toBeHidden();
  await editor.getByRole("combobox", { name: "선탑 진행 상태", exact: true }).selectOption("completed");
  await editor.getByRole("group", { name: "기록할 내용", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/ong-staffing-simple-${width}.png`, fullPage: true });
  await editor.getByRole("button", { name: "실제 참여", exact: true }).click();
  await expect(editor.getByRole("combobox", { name: "선탑 진행 상태", exact: true })).toBeHidden();
  await editor.getByRole("button", { name: "실제 참여 추가", exact: true }).click();
  await editor.getByLabel("실제 참여 일자 2", { exact: true }).fill("2020-01-09");
  await editor.getByLabel("참여 비고 2", { exact: true }).fill("실제 선탑 동승 확인");
  await editor.getByRole("button", { name: "연락·할 일", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "연락 결과", exact: true })).toHaveValue("선탑 실제 참여를 전화로 확인함");
  await editor.getByRole("button", { name: "선탑 진행", exact: true }).click();
  await expect(editor.getByRole("combobox", { name: "선탑 진행 상태", exact: true })).toHaveValue("completed");
  await editor.getByRole("button", { name: "실제 참여", exact: true }).click();
  await expect(editor.getByLabel("참여 비고 2", { exact: true })).toHaveValue("실제 선탑 동승 확인");
  expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await editor.getByRole("button", { name: "진행 기록 저장", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].dates).toEqual(preparation.dates);
  expect(writes[0].training).toEqual({ ...preparation.training, status: "completed" });
  expect(writes[0].records).toEqual([{ id: expect.any(String), kind: "training", date: "2020-01-09", note: "실제 선탑 동승 확인" }, ...preparation.records]);
  expect(writes[0].follow_up).toMatchObject({ last_contact: { date: "2020-01-09", method: "phone", result: "선탑 실제 참여를 전화로 확인함" } });
  expect(writes[0].training_availability).toBe(preparation.training_availability);
  expect(writes[0].note).toBe(preparation.note);

  await edit.click();
  await editor.getByRole("button", { name: "투입 날짜", exact: true }).click();
  await expect(editor.getByLabel("날짜 2", { exact: true })).toHaveValue("2099-09-22");
  await editor.getByRole("button", { name: "날짜 삭제", exact: true }).nth(1).click();
  await editor.getByRole("button", { name: "연락·할 일", exact: true }).click();
  await editor.getByRole("button", { name: "투입 날짜", exact: true }).click();
  await expect(editor.getByLabel("날짜 2", { exact: true })).toHaveCount(0);
  await expect(editor.getByLabel("날짜별 투입 확정 1", { exact: true })).toBeChecked();
  await editor.getByRole("button", { name: "날짜 추가", exact: true }).click();
  await editor.getByRole("button", { name: "연락·할 일", exact: true }).click();
  await editor.getByRole("button", { name: "진행 기록 저장", exact: true }).click();
  await expect(editor.getByLabel("날짜 2", { exact: true })).toBeVisible();
  await expect(editor.getByRole("alert")).toContainText("날짜가 유효하고 중복되지 않는지");
  expect(writes).toHaveLength(1);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
