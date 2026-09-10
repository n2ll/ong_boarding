import { test, expect } from "@playwright/test";

test("연결 후보와 관심 구분, 날짜별 준비 저장 실패 재시도와 모바일 편집", async ({ page }) => {
  test.setTimeout(60_000);
  const at = "2026-09-09T07:00:00Z";
  const candidates = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, applicant_id: i + 1, agent_stage: null, sent_at: at, responded_at: null, applicants: { id: i + 1, name: `가상후보${i + 1}`, own_vehicle: null, status: "스크리닝 중" } }));
  let preparations: unknown[] = [];
  let candidateReads = 0;
  let finishFailedRefresh = () => {};
  const refreshGate = new Promise<void>((resolve) => { finishFailedRefresh = resolve; });
  const writes: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    if (path.endsWith("/candidates") && ++candidateReads > 1) {
      await refreshGate;
      return route.fulfill({ status: 503, json: { error: "fixture candidate refresh failure" } });
    }
    if (path.endsWith("/staffing-preparation")) {
      if (request.method() === "GET") return route.fulfill({ json: { preparations, suggestions: [], primary_candidates: [], conflict_check_incomplete: false } });
      const body = request.postDataJSON(); writes.push(body);
      if (writes.length === 1) return route.abort("failed");
      const saved = { applicant_id: body.applicant_id, preparation: { source: "manager", dates: body.dates, training_availability: body.training_availability, note: body.note }, event_id: 1, updated_at: at, invalid: false };
      preparations = [saved];
      return route.fulfill({ json: { ...saved, deduplicated: true } });
    }
    if (request.method() !== "GET") { unexpected.push(path); return route.abort(); }
    const responses: Record<string, unknown> = {
      "/api/admin/jobs": { jobs: [{ id: 11, title: "가상 예비 백업 배송", status: "active", recruit_mode: "internal", exposure: "targeted", counts: { sent: 50 }, interest_count: 0, created_at: at, capacity: 1 }] },
      "/api/admin/jobs/11/candidates": { candidates, acquisition: { status: "error" } },
      "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] },
      "/api/admin/confirm/pending": { pending: [], total: 0 },
      "/api/admin/agent/kill-switch": { mode: "off", disabled: true, env_forced: false },
    };
    return route.fulfill({ json: responses[path] ?? { data: [] } });
  });
  await page.addInitScript(() => localStorage.setItem("ongboarding:staffing-author:v1", "가상매니저"));
  await page.goto("/jobs");
  await page.getByRole("button", { name: "전체 후보 50명", exact: true }).click();
  await expect(page.getByText("연결 후보 50명 · 관심 표시 0명", { exact: true })).toBeVisible();
  await expect(page.getByText("50명 지원", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "날짜별 배차 준비 펼치기" }).click();
  await page.getByLabel("비교할 날짜", { exact: true }).fill("2026-09-22");
  await page.getByRole("button", { name: "가상후보1 배차 준비 편집", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "가상후보1 배차 준비", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("후보 역할 1")).toBeDisabled();
  await dialog.getByLabel("가능 여부 1").selectOption("available");
  await dialog.getByLabel("후보 역할 1").selectOption("reserve_candidate");
  await dialog.getByLabel("가능 여부 1").selectOption("unavailable");
  await expect(dialog.getByLabel("후보 역할 1")).toHaveValue("unassigned");
  await dialog.getByLabel("가능 여부 1").selectOption("available");
  await dialog.getByLabel("후보 역할 1").selectOption("reserve_candidate");
  await dialog.getByLabel("선탑 가능 시간", { exact: true }).fill("9/16 오전 가능, 시간 조율 필요");
  await dialog.getByLabel("관리자 메모").fill("지원자 답장 확인 후 정리");
  await dialog.getByRole("button", { name: "배차 준비 저장" }).click();
  await expect(dialog.getByRole("alert")).toContainText("입력 내용은 유지됩니다");
  await expect(dialog.getByLabel("선탑 가능 시간", { exact: true })).toHaveValue("9/16 오전 가능, 시간 조율 필요");
  await dialog.getByRole("button", { name: "배차 준비 저장" }).click();
  await expect(page.getByRole("dialog").filter({ hasText: "관리자가 확인한 내용을 기록합니다." })).not.toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[0].action_key).toBe(writes[1].action_key);
  await expect(page.getByText("2026-09-22 · 가능 1명 · 본담당 후보 0명 · 예비 후보 1명", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/ong-staffing-preparation-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "지원서 다시 확인", exact: true }).click();
  await expect.poll(() => candidateReads).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "가상후보1 배차 준비 편집", exact: true }).click();
  await expect(dialog.getByLabel("날짜 1", { exact: true })).toHaveValue("2026-09-22");
  await expect(dialog.getByLabel("후보 역할 1")).toHaveValue("reserve_candidate");
  const button = dialog.getByRole("button", { name: "배차 준비 저장" });
  await expect(button).toBeInViewport();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/ong-staffing-preparation-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByLabel("관리자 메모").fill("저장 전 변경");
  const failedRefresh = page.waitForResponse((response) => response.url().endsWith("/candidates") && response.status() === 503);
  finishFailedRefresh();
  await failedRefresh;
  await expect(dialog.getByLabel("관리자 메모")).toHaveValue("저장 전 변경");
  await page.keyboard.press("Escape");
  await expect(page.getByText("저장하지 않은 변경이 있어요", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});


for (const width of [1280, 390]) test(`수신 답변 제안 확인 반영과 본담당 후보 중복 경고 ${width}px`, async ({ page, baseURL }) => {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL! }]);
  await page.setViewportSize({ width, height: 844 });
  const at = "2027-04-09T01:00:00Z";
  const candidates = [1, 2].map((id) => ({ id, applicant_id: id, agent_stage: null, responded_at: at, sent_at: at,
    applicants: { id, name: `가상후보${id}`, own_vehicle: null, status: "스크리닝 중" } }));
  const suggestions = [
    { applicant_id: 1, event_id: 21, source_message_id: "sms-1", source_created_at: at, quote: "1, 3번\n22일 가능", date: "2027-04-22", availability: "available", reason: null },
    { applicant_id: 2, event_id: 22, source_message_id: "sms-2", source_created_at: at, quote: "22일 가능할 것 같아요", date: null, availability: "unknown", reason: "날짜·근무 가능 여부를 원문에서 확인해주세요." },
  ];
  const writes: Record<string, unknown>[] = [];
  const errors: string[] = [], unexpected: string[] = [];
  let preparations: unknown[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.routeWebSocket("**/*", () => {});
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    if (path.endsWith("/staffing-preparation")) {
      if (request.method() === "GET") return route.fulfill({ json: { preparations, suggestions,
        primary_candidates: [{ applicant_id: 1, date: "2027-04-22", job_id: 12, job_title: "다른 가상 배송 라인" }], conflict_check_incomplete: false } });
      const body = request.postDataJSON(); writes.push(body);
      const saved = { applicant_id: body.applicant_id, preparation: { source: "manager", dates: body.dates, training_availability: body.training_availability, note: body.note }, event_id: 30, updated_at: at, invalid: false };
      preparations = [saved]; return route.fulfill({ json: saved });
    }
    if (request.method() !== "GET") { unexpected.push(path); return route.abort(); }
    const responses: Record<string, unknown> = {
      "/api/admin/jobs": { jobs: [{ id: 11, title: "가상 배송 라인", status: "active", recruit_mode: "internal", exposure: "targeted", counts: { sent: 2 }, interest_count: 0, created_at: at, capacity: 1 }] },
      "/api/admin/jobs/11/candidates": { candidates, acquisition: { status: "error" } },
      "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] },
      "/api/admin/confirm/pending": { pending: [], total: 0 },
      "/api/admin/agent/kill-switch": { mode: "off", disabled: true, env_forced: false },
    };
    return route.fulfill({ json: responses[path] ?? { data: [] } });
  });
  await page.addInitScript(() => localStorage.setItem("ongboarding:staffing-author:v1", "가상매니저"));
  await page.goto("/jobs");
  await page.getByRole("button", { name: "전체 후보 2명", exact: true }).click();
  await page.getByRole("button", { name: "날짜별 배차 준비 펼치기" }).click();
  await expect(page.getByText("답변에서 찾은 날짜 · 2027-04-22 가능", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByLabel("비교할 날짜", { exact: true }).fill("2027-04-22");
  await page.getByRole("button", { name: "가상후보1 배차 준비 편집", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "가상후보1 배차 준비", exact: true });
  await expect(dialog.getByText("수신 답변에서 찾은 제안", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("날짜 1", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "원문 확인 후 초안에 반영" }).click();
  await expect(dialog.getByLabel("날짜 1", { exact: true })).toHaveValue("2027-04-22");
  await expect(dialog.getByLabel("후보 역할 1")).toHaveValue("unassigned");
  expect(writes).toHaveLength(0);
  await dialog.getByLabel("후보 역할 1").selectOption("primary_candidate");
  await expect(dialog.getByRole("alert")).toContainText("다른 가상 배송 라인");
  await expect(dialog.getByRole("button", { name: "배차 준비 저장" })).toBeEnabled();
  await page.screenshot({ path: `/tmp/ong-staffing-suggestions-${width}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole("button", { name: "배차 준비 저장" }).click();
  await expect(dialog).not.toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].dates).toEqual([{ date: "2027-04-22", availability: "available", role: "primary_candidate" }]);
  await page.getByRole("button", { name: "가상후보1 배차 준비 편집", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "원문 확인 후 초안에 반영" })).toBeDisabled();
  await expect(dialog.getByLabel("후보 역할 1")).toHaveValue("primary_candidate");
  await dialog.getByRole("button", { name: "창 닫기", exact: true }).click();
  await page.getByRole("button", { name: "가상후보2 배차 준비 편집", exact: true }).click();
  const ambiguous = page.getByRole("dialog", { name: "가상후보2 배차 준비", exact: true });
  await expect(ambiguous.getByText("“22일 가능할 것 같아요”", { exact: true })).toBeVisible();
  await expect(ambiguous.getByRole("button", { name: "원문 확인 후 초안에 반영" })).toHaveCount(0);
  await expect(ambiguous.getByLabel("가능 여부 1")).toHaveValue("unknown");
  expect(writes).toHaveLength(1); expect(unexpected).toEqual([]); expect(errors).toEqual([]);
});


for (const width of [1280, 390]) test(`선탑 후 본인 의사와 팀 기록 이력, 충돌한 내 초안 보존 ${width}px`, async ({ page, baseURL }) => {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL! }]);
  await page.setViewportSize({ width, height: 844 });
  const at = "2026-09-10T00:00:00Z";
  const old = { source: "manager", dates: [], training_availability: "오전 가능", note: "이전 상담 메모" };
  const training = { status: "coordinating", backup_intent: "unknown", scheduled_at: "", first_loading_location: "", linked_pro: "" };
  const teammate = { ...old, training, note: "동료가 프로 일정 확인 중" };
  const actor = { account_id: "fixture-account", name: "동료매니저" };
  let snapshot: Record<string, unknown> = { applicant_id: 1, event_id: 1, updated_at: at, preparation: old, invalid: false, actor: null,
    history: [{ event_id: 1, updated_at: at, preparation: old, invalid: false, actor: null }] };
  const writes: Record<string, unknown>[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.routeWebSocket("**/*", () => {});
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/staffing-preparation")) {
      if (request.method() === "GET") return route.fulfill({ json: { preparations: [snapshot], suggestions: [], primary_candidates: [], conflict_check_incomplete: false } });
      const body = request.postDataJSON(); writes.push(body);
      if (writes.length === 1) {
        snapshot = { applicant_id: 1, event_id: 2, updated_at: at, preparation: teammate, invalid: false, actor,
          history: [{ event_id: 2, updated_at: at, preparation: teammate, invalid: false, actor }, ...(snapshot.history as unknown[])] };
        return route.fulfill({ status: 409, json: { error: "동료가 먼저 기록을 저장했어요.", conflict: true, latest: snapshot } });
      }
      const prep = { source: "manager", dates: body.dates, training_availability: body.training_availability, training: body.training, note: body.note };
      const revision = { event_id: 3, updated_at: at, preparation: prep, invalid: false, actor: { account_id: "fixture-account", name: body.actor_name } };
      snapshot = { applicant_id: 1, ...revision, history: [revision, ...(snapshot.history as unknown[])] };
      return route.fulfill({ json: snapshot });
    }
    if (request.method() !== "GET") { unexpected.push(path); return route.abort(); }
    const fixtures: Record<string, unknown> = {
      "/api/admin/jobs": { jobs: [{ id: 11, title: "가상 배송 라인", status: "active", recruit_mode: "internal", exposure: "targeted", counts: { sent: 1 }, interest_count: 0, created_at: at, capacity: 1 }] },
      "/api/admin/jobs/11/candidates": { candidates: [{ id: 1, applicant_id: 1, responded_at: at, applicants: { name: "선탑후보", own_vehicle: null, status: "스크리닝 중" } }], acquisition: { status: "error" } },
      "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] },
      "/api/admin/confirm/pending": { pending: [], total: 0 },
      "/api/admin/agent/kill-switch": { mode: "off", disabled: true, env_forced: false },
    };
    return route.fulfill({ json: fixtures[path] ?? { data: [] } });
  });
  await page.goto("/jobs");
  await page.getByRole("button", { name: "전체 후보 1명", exact: true }).click();
  await page.getByRole("button", { name: "날짜별 배차 준비 펼치기" }).click();
  await page.getByRole("button", { name: "선탑후보 배차 준비 편집", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "선탑후보 배차 준비", exact: true });
  await expect(dialog.getByRole("combobox", { name: "선탑 진행 상태", exact: true })).toHaveValue("reviewing");
  await dialog.getByLabel("기록 작성자", { exact: true }).fill("김매니저");
  await dialog.getByRole("combobox", { name: "선탑 진행 상태", exact: true }).selectOption("completed");
  await dialog.getByRole("combobox", { name: "선탑 후 본인 백업 진행 의사", exact: true }).selectOption("declined");
  await dialog.getByLabel("선탑 지정 일시 (한국시간)", { exact: true }).fill("2026-09-15T07:30");
  await dialog.getByLabel("선탑 첫 상차지", { exact: true }).fill("선탑 교육 상차지");
  await dialog.getByLabel("선탑 연결 프로", { exact: true }).fill("담당 프로");
  await dialog.getByLabel("관리자 메모").fill("내 선탑 완료 확인");
  await dialog.getByRole("button", { name: "배차 준비 저장", exact: true }).click();
  await expect(dialog.getByLabel("관리자 메모")).toHaveValue("내 선탑 완료 확인");
  await expect(dialog.getByText("동료가 프로 일정 확인 중", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "배차 준비 저장", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "최신 기록 불러오기", exact: true }).click();
  await expect(dialog.getByLabel("관리자 메모")).toHaveValue("동료가 프로 일정 확인 중");
  await dialog.getByText("보관한 내 초안", { exact: true }).click();
  await expect(dialog.getByText("내 선탑 완료 확인", { exact: true })).toBeVisible();
  await dialog.getByRole("combobox", { name: "선탑 진행 상태", exact: true }).selectOption("completed");
  await dialog.getByRole("combobox", { name: "선탑 후 본인 백업 진행 의사", exact: true }).selectOption("declined");
  await dialog.getByLabel("선탑 지정 일시 (한국시간)", { exact: true }).fill("2026-09-15T07:30");
  await dialog.getByLabel("관리자 메모").fill("동료 일정 확인 후, 본인 백업 진행 안 함 확인");
  await dialog.getByRole("button", { name: "배차 준비 저장", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(writes[0].base_event_id).toBe(1); expect(writes[1].base_event_id).toBe(2);
  expect((writes[1].training as Record<string, unknown>).backup_intent).toBe("declined");
  expect((writes[1].training as Record<string, unknown>).scheduled_at).toBe("2026-09-15T07:30:00+09:00");
  await page.getByRole("button", { name: "선탑후보 배차 준비 편집", exact: true }).click();
  await expect(dialog.getByLabel("기록 작성자", { exact: true })).toHaveValue("김매니저");
  await expect(dialog.getByRole("combobox", { name: "선탑 진행 상태", exact: true })).toHaveValue("completed");
  await expect(dialog.getByRole("combobox", { name: "선탑 후 본인 백업 진행 의사", exact: true })).toHaveValue("declined");
  await dialog.getByText("팀 변경 이력 3건", { exact: true }).click();
  await expect(dialog.getByText("이전 상담 메모", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/입력한 작성자: 동료매니저/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "배차 준비 저장", exact: true })).toBeInViewport();
  await page.screenshot({ path: `/tmp/ong-training-team-${width}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(unexpected).toEqual([]); expect(errors).toEqual([]);
});
