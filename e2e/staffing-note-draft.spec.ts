import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) test(`메모 제안을 검토한 항목만 저장하고 기존 확정을 보존한다 ${width}px`, async ({ page, baseURL }) => {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL! }]);
  await page.setViewportSize({ width, height: 844 });
  await page.routeWebSocket("**/*", () => {});
  const at = "2026-01-10T01:00:00Z";
  const preparation = { source: "manager", dates: [{ date: "2099-09-21", availability: "available", role: "primary_candidate", confirmation: "confirmed" }],
    training_availability: "오후 가능", training: { status: "coordinating", backup_intent: "unknown", scheduled_at: "", first_loading_location: "기존 상차지", linked_pro: "기존 프로" },
    records: [], note: "기존 팀 메모", follow_up: { owner: "담당자", next_action: "기존 할 일", due_date: "2099-09-21", status: "open", last_contact: null } };
  let snapshot = { applicant_id: 1, event_id: 1, updated_at: at, actor: null, invalid: false, preparation, history: [] };
  const writes: Array<Record<string, unknown>> = [], unexpected: string[] = [], errors: string[] = [];
  let generates = 0, saveAttempts = 0;
  const note = "오늘 전화 통화함. 9/16 오전 선탑 희망. 내일 다시 전화하기.";
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/admin/jobs/11/staffing-note-draft") {
      generates++;
      expect(request.postDataJSON()).toMatchObject({ applicant_id: 1, note, reference_date: "2020-01-09" });
      if (generates === 1) return route.fulfill({ status: 503, json: { error: "잠시 후 다시 정리해주세요." } });
      return route.fulfill({ json: { proposal: { changes: [
        { field: "contact", value: { date: "2020-01-09", method: "phone", result: "선탑 희망 시간 확인" }, evidence: "오늘 전화 통화함" },
        { field: "training_availability", value: generates > 2 ? "9/16 오전 선탑 희망 · 재확인" : "9/16 오전 선탑 희망", evidence: "9/16 오전 선탑 희망" },
        { field: "next_action", value: "내일 다시 전화하기", evidence: "내일 다시 전화하기" },
      ], questions: ["정확한 선탑 일시는 직접 조율해주세요."] } } });
    }
    if (url.pathname === "/api/admin/jobs/11/staffing-preparation") {
      if (request.method() === "GET") return route.fulfill({ json: { preparations: [snapshot], suggestions: [], primary_candidates: [], conflict_check_incomplete: false } });
      const body = request.postDataJSON(); writes.push(body); saveAttempts++;
      if (saveAttempts === 1) return route.abort("failed");
      if (saveAttempts === 3) {
        snapshot = { ...snapshot, event_id: 3, preparation: { ...snapshot.preparation, training_availability: "동료가 확인한 오후" } };
        return route.fulfill({ status: 409, json: { conflict: true, latest: snapshot, error: "동료가 먼저 기록을 수정했어요." } });
      }
      snapshot = { ...snapshot, event_id: 2, preparation: { ...preparation, ...body } };
      return route.fulfill({ json: snapshot });
    }
    if (request.method() !== "GET") { unexpected.push(url.pathname); return route.abort(); }
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
  await page.getByRole("button", { name: "가상후보1 메모로 기록", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "가상후보1 진행 기록", exact: true });
  await editor.getByRole("textbox", { name: "통화·진행 메모", exact: true }).fill(note);
  await editor.getByLabel("메모 기준일", { exact: true }).fill("2020-01-09");
  await editor.getByRole("button", { name: "AI로 정리", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("다시 정리");
  await expect(editor.getByRole("textbox", { name: "통화·진행 메모", exact: true })).toHaveValue(note);
  await editor.getByRole("button", { name: "AI로 정리", exact: true }).click();
  await expect(editor.getByText("저장할 내용 확인", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await expect(editor.getByText("기존: 오후 가능", { exact: true })).toBeVisible();
  await editor.getByRole("checkbox", { name: "다음 할 일 반영", exact: true }).uncheck();
  await page.screenshot({ path: `/tmp/ong-note-review-${width}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const save = editor.getByRole("button", { name: "확인하고 저장", exact: true });
  await expect(save).toBeInViewport();
  await save.click();
  await expect(editor.getByRole("alert")).toContainText("입력 내용은 유지");
  await save.click();
  await expect(editor).not.toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[0].action_key).toBe(writes[1].action_key);
  expect(writes[1].dates).toEqual(preparation.dates);
  expect(writes[1].training).toEqual(preparation.training);
  expect(writes[1].training_availability).toBe("9/16 오전 선탑 희망");
  expect(writes[1].follow_up).toMatchObject({ owner: "담당자", next_action: "기존 할 일", due_date: "2099-09-21", last_contact: { date: "2020-01-09", method: "phone", result: "선탑 희망 시간 확인" } });
  expect(writes[1].note).toBe("기존 팀 메모");
  await page.getByRole("button", { name: "가상후보1 메모로 기록", exact: true }).click();
  await editor.getByRole("textbox", { name: "통화·진행 메모", exact: true }).fill(note);
  await editor.getByLabel("메모 기준일", { exact: true }).fill("2020-01-09");
  await editor.getByRole("button", { name: "AI로 정리", exact: true }).click();
  await editor.getByRole("button", { name: "확인하고 저장", exact: true }).click();
  await editor.getByRole("button", { name: "최신 기록 불러오기", exact: true }).click();
  await editor.getByText("보관한 내 초안", { exact: true }).click();
  await expect.soft(editor.locator("details").filter({ hasText: "보관한 내 초안" })).toContainText("9/16 오전 선탑 희망 · 재확인");
  await editor.getByRole("button", { name: "AI로 정리", exact: true }).click();
  await expect(editor.getByText("기존: 동료가 확인한 오후", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "직접 입력", exact: true }).click();
  await editor.getByRole("button", { name: "선탑 진행", exact: true }).click();
  await expect.soft(editor.getByLabel("선탑 가능 시간", { exact: true })).toHaveValue("9/16 오전 선탑 희망 · 재확인");
  await editor.getByLabel("선탑 가능 시간", { exact: true }).fill("관리자가 직접 정리한 시간");
  await editor.getByRole("button", { name: "메모로 기록", exact: true }).click();
  await expect.soft(editor.getByText("저장할 내용 확인", { exact: true })).not.toBeVisible();
  await editor.getByRole("button", { name: "직접 입력", exact: true }).click();
  await editor.getByRole("button", { name: "선탑 진행", exact: true }).click();
  await expect(editor.getByLabel("선탑 가능 시간", { exact: true })).toHaveValue("관리자가 직접 정리한 시간");
  expect(unexpected).toEqual([]); expect(errors).toEqual([]);
});
