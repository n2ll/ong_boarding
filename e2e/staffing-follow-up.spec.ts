import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) test(`연락·할 일을 배차 변경 없이 기록하고 후속 처리를 이어간다 ${width}px`, async ({ page, baseURL }) => {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL! }]);
  await page.setViewportSize({ width, height: 844 });
  await page.routeWebSocket("**/*", () => {});
  const at = "2026-01-10T01:00:00Z";
  const applicant = { id: 1, name: "가상후보1", phone: null, own_vehicle: null, status: "스크리닝 중" };
  const preparation = {
    source: "manager",
    dates: width === 1280 ? [{ date: "2099-09-21", availability: "available", role: "primary_candidate", confirmation: "unconfirmed" }] : [],
    training_availability: "오전 가능",
    training: { status: "completed", backup_intent: "interested", scheduled_at: "2020-01-08T09:00:00+09:00", first_loading_location: "가상 교육장", linked_pro: "가상 프로" },
    records: [{ id: "00000000-0000-4000-8000-000000000001", kind: "training", date: "2020-01-08", note: "실제 동승 확인" }],
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
        if (width === 390 && writes.length === 1) return route.fulfill({ status: 503, json: { error: "저장 연결 실패" } });
        const saved = { ...preparation, dates: body.dates, training_availability: body.training_availability, training: body.training, records: body.records, note: body.note, follow_up: body.follow_up };
        const revision = { ...firstRevision, event_id: snapshot.event_id + 1, preparation: saved };
        snapshot = { ...revision, applicant_id: 1, history: [revision, ...snapshot.history] };
        return route.fulfill({ json: snapshot });
      }
    }
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    const fixtures: Record<string, unknown> = {
      "/api/admin/jobs": { jobs: [{ id: 11, title: "가상 배송 라인", status: "active", recruit_mode: "internal", exposure: "targeted", counts: { sent: 1 }, interest_count: 0, created_at: at, capacity: 1 }] },
      "/api/admin/jobs/11/candidates": { candidates: [{ id: 1, applicant_id: 1, agent_stage: "exploration", sent_at: at, responded_at: at, applicants: applicant }], acquisition: { status: "error" } },
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
  // 비교 중인 날짜가 기록에 없어도 연락 간편 편집이 배차 날짜를 추가해서는 안 된다.
  await page.getByLabel("비교할 날짜", { exact: true }).fill("2099-09-22");
  const edit = page.getByRole("button", { name: "가상후보1 연락·할 일 기록", exact: true });
  await expect(edit).toBeVisible();
  await edit.click();
  const editor = page.getByRole("dialog", { name: "가상후보1 연락·다음 할 일", exact: true });
  await editor.getByRole("button", { name: "연락 기록 추가", exact: true }).click();
  await editor.getByLabel("최근 연락 일자", { exact: true }).fill("2020-01-09");
  await editor.getByRole("combobox", { name: "연락 방법", exact: true }).selectOption(width === 1280 ? "phone" : "sms");
  await editor.getByRole("textbox", { name: "연락 결과", exact: true }).fill("일정 확인을 요청함");

  if (width === 1280) {
    await editor.getByLabel("후속 담당자", { exact: true }).fill("가상담당자");
    await editor.getByLabel("다음 할 일", { exact: true }).fill("연결 프로 일정 확인");
    await editor.getByLabel("처리 예정일", { exact: true }).fill("2020-01-10");
    await editor.getByRole("button", { name: "연락·할 일 저장", exact: true }).click();
    await expect(editor).not.toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0].follow_up).toEqual({ owner: "가상담당자", next_action: "연결 프로 일정 확인", due_date: "2020-01-10", status: "open", last_contact: { date: "2020-01-09", method: "phone", result: "일정 확인을 요청함" } });
    await expect(page.getByText("연결 프로 일정 확인", { exact: false }).first()).toBeVisible();
    const filter = page.getByRole("combobox", { name: "후속 할 일 필터", exact: true });
    await filter.selectOption("due");
    await expect(edit).toBeVisible();
    await page.getByLabel("담당자 검색", { exact: true }).fill("다른담당자");
    await expect(edit).toBeHidden();
    await page.getByLabel("담당자 검색", { exact: true }).fill("가상담당자");
    await expect(edit).toBeVisible();
    await filter.selectOption("done");
    await expect(edit).toBeHidden();
    await filter.selectOption("all");
    await edit.click();
    await editor.getByLabel("할 일 완료", { exact: true }).check();
    await editor.getByRole("button", { name: "연락·할 일 저장", exact: true }).click();
    await expect(editor).not.toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[1].follow_up).toMatchObject({ status: "done" });
    await filter.selectOption("done");
    await expect(edit).toBeVisible();
    await filter.selectOption("open");
    await expect(edit).toBeHidden();
    await filter.selectOption("all");
  } else {
    await editor.getByRole("button", { name: "연락·할 일 저장", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("저장 연결 실패");
    await expect(editor.getByRole("textbox", { name: "연락 결과", exact: true })).toHaveValue("일정 확인을 요청함");
    await expect(editor.getByLabel("최근 연락 일자", { exact: true })).toHaveValue("2020-01-09");
    expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/ong-staffing-follow-up-${width}.png`, fullPage: true });
    await editor.getByRole("button", { name: "연락·할 일 저장", exact: true }).click();
    await expect(editor).not.toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[0].action_key).toEqual(expect.any(String));
    expect(writes[1].action_key).toBe(writes[0].action_key);
    expect(writes[1].follow_up).toEqual(writes[0].follow_up);
    expect(writes[1].follow_up).toMatchObject({ last_contact: { date: "2020-01-09", method: "sms", result: "일정 확인을 요청함" } });
  }
  for (const saved of writes) {
    expect(saved.dates).toEqual(preparation.dates);
    expect(saved.training).toEqual(preparation.training);
    expect(saved.training_availability).toBe(preparation.training_availability);
    expect(saved.records).toEqual(preparation.records);
    expect(saved.note).toBe(preparation.note);
  }
  if (width === 1280) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/ong-staffing-follow-up-${width}.png`, fullPage: true });
  }
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
