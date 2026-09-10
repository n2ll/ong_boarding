import { test, expect } from "@playwright/test";

for (const width of [1280, 390]) test(`선탑 원문에서 대화·전화로 연결하고 작성 중인 팀 메모를 보존한다 ${width}px`, async ({ page, baseURL }) => {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL! }]);
  await page.setViewportSize({ width, height: 844 });
  await page.routeWebSocket("**/*", () => {});
  const at = "2027-04-09T01:00:00Z";
  const quote = "선탑은 화요일 오전에 가능합니다";
  const applicant = { id: 1, name: "가상선탑후보", phone: "01000000000", own_vehicle: null, status: "스크리닝 중", sms_opt_out_at: null };
  const training = { status: "coordinating", backup_intent: "unknown", scheduled_at: "", first_loading_location: "", linked_pro: "" };
  const preparation = { source: "manager", dates: [], training_availability: "화요일 오전", training, note: "동료가 프로 일정 확인 중" };
  let snapshot = { applicant_id: 1, preparation, event_id: 1, updated_at: at, invalid: false, actor: null, history: [] };
  const messagesRead: string[] = [], writes: Record<string, unknown>[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    if (path.endsWith("/staffing-preparation")) {
      if (request.method() === "GET") return route.fulfill({ json: { preparations: [snapshot], suggestions: [{ applicant_id: 1, event_id: 2, source_message_id: "m1", source_created_at: at, quote, kind: "training", date: null, availability: "unknown", reason: "선탑 참여 의사와 가능 시간을 확인하고 연락해주세요." }], primary_candidates: [], conflict_check_incomplete: false } });
      const body = request.postDataJSON(); writes.push(body);
      snapshot = { ...snapshot, event_id: 3, preparation: { source: "manager", dates: body.dates, training_availability: body.training_availability, training: body.training, note: body.note } };
      return route.fulfill({ json: snapshot });
    }
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${path}`); return route.abort(); }
    if (path === "/api/admin/messages/1") messagesRead.push(url.search);
    const responses: Record<string, unknown> = {
      "/api/admin/jobs": { jobs: [{ id: 11, title: "가상 백업 라인", status: "active", recruit_mode: "internal", exposure: "targeted", counts: { sent: 1 }, interest_count: 0, created_at: at, capacity: 1 }] },
      "/api/admin/jobs/11/candidates": { candidates: [{ id: 1, applicant_id: 1, agent_stage: "exploration", sent_at: at, responded_at: at, applicants: applicant }], acquisition: { status: "error" } },
      "/api/admin/applicants/1": { applicant, candidates: [{ id: 1, job_id: 11, job_title: "가상 백업 라인", job_branch: "가상 권역", agent_stage: "exploration" }] },
      "/api/admin/messages/1": { messages: [{ id: "m1", direction: "inbound", body: quote, created_at: at }], events: [], jobs: {}, draft: null, agent_stage: "exploration", access_token: null, manual_message_attention: { state: "ready", items: [], totalCount: 0, truncated: false }, context_status: { reasoning: "ready", pool_events: "ready", job_labels: "ready" } },
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
  await expect(page.getByText("선탑 관련 답변 · 원문 확인", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "가상선탑후보 진행 기록", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "가상선탑후보 진행 기록", exact: true });
  await editor.getByRole("button", { name: "선탑 진행", exact: true }).click();
  await expect(editor.getByText(/다음 확인: 문자나 전화로 선탑/)).toBeVisible();
  await expect(editor.getByRole("link", { name: "가상선탑후보에게 전화하기", exact: true })).toHaveAttribute("href", "tel:01000000000");
  await expect(editor.getByRole("button", { name: "원문 확인 후 초안에 반영" })).toHaveCount(0);
  await editor.getByLabel("관리자 메모").fill("지원자와 통화 후 선탑 프로 조율 예정");
  await editor.getByRole("button", { name: "가상선탑후보 선탑 대화 열기", exact: true }).click();
  await expect(editor).not.toBeVisible();
  const chat = page.getByRole("dialog", { name: "가상선탑후보", exact: true });
  await expect(chat.getByText(quote, { exact: true })).toBeVisible();
  const composer = chat.getByRole("textbox", { name: "지원자에게 보낼 문자", exact: true });
  await composer.fill("선탑 일정 조율을 위한 검수 초안입니다.");
  const send = chat.getByRole("button", { name: "문자 발송", exact: true });
  await expect(send).toBeInViewport();
  await send.click({ trial: true, timeout: 3_000 });
  await composer.fill("");
  expect(messagesRead.some((query) => new URLSearchParams(query).get("job_id") === "11")).toBe(true);
  expect(writes).toHaveLength(0); expect(unexpected).toEqual([]);
  await page.screenshot({ path: `/tmp/ong-training-contact-${width}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await chat.getByRole("button", { name: "지원자 상세 닫기", exact: true }).click();
  await expect(editor.getByLabel("관리자 메모")).toHaveValue("지원자와 통화 후 선탑 프로 조율 예정");
  await expect(editor.getByLabel("선탑 가능 시간", { exact: true })).toHaveValue("화요일 오전");
  await editor.getByRole("button", { name: "진행 기록 저장", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].note).toBe("지원자와 통화 후 선탑 프로 조율 예정");
  expect(writes[0].training).toEqual(training);
  expect(unexpected).toEqual([]); expect(errors).toEqual([]);
});
