import { test, expect } from "@playwright/test";

test.use({ actionTimeout: 10_000 });

test("희망 조건으로 후보 찾기·저장·선택 해제·조회 실패 복구", async ({ page }) => {
  test.setTimeout(120_000);
  const at = "2026-09-08T05:00:00Z";
  const names = ["정기후보", "백업후보", "양쪽후보", "미등록후보"];
  const prefs = (kind: string, area: string) => ({ kind, area, schedule: "금요일 오후", vehicle: "세단", notice: "하루 전", updated_at: at });
  const summaryById = Object.fromEntries([prefs("regular", "성동구"), prefs("backup", "성동구"), prefs("both", "안양시")].map((pool_preferences, i) => [i + 1, { pool_preferences, last_ping_at: null, last_link_view_at: null, last_interest: null, last_reply_at: null }]));
  let failSummary = false;
  const errors: string[] = [];
  const unexpectedWrites: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === "cdn.jsdelivr.net" && url.pathname.endsWith("/pretendardvariable.min.css")) return route.fulfill({ contentType: "text/css", body: "" });
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    if (path === "/api/admin/pool-events/summary") return route.fulfill({ status: failSummary ? 500 : 200, json: failSummary ? { error: "fixture summary failure" } : { summaryById } });
    if (request.method() !== "GET") { unexpectedWrites.push(`${request.method()} ${path}`); return route.abort(); }
    const responses: Record<string, unknown> = {
      "/api/admin/applicants": { data: names.map((name, i) => ({ id: i + 1, name, phone: `0100000000${i}`, status: "스크리닝 중", agent_stage: "paused", created_at: at, job_links: [] })) },
      "/api/admin/jobs": { jobs: [] },
      "/api/admin/branches": { data: [] },
      "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] },
      "/api/admin/confirm/pending": { pending: [], total: 0 },
      "/api/admin/agent/handoffs": { by_category: {}, total: 0 },
      "/api/admin/agent/kill-switch": { mode: "off", disabled: true },
    };
    return route.fulfill({ json: responses[path] ?? { data: [] } });
  });
  await page.goto("/pipeline?view=list");
  const rows = page.getByRole("button", { name: /후보 지원자 상세 열기/ });
  await expect(rows).toHaveCount(4);
  await expect(page.getByText("배송 희망 미등록", { exact: true })).toBeVisible();
  const kind = page.getByRole("combobox", { name: "배송 희망", exact: true });
  const query = page.getByRole("searchbox", { name: "희망 조건 검색", exact: true });
  await kind.selectOption("backup");
  await expect(rows).toHaveCount(2);
  await page.getByRole("checkbox", { name: "백업후보 선택", exact: true }).check();
  await query.fill("성동 금요일 세단");
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "백업후보 선택", exact: true })).not.toBeChecked();
  await page.locator("details summary").click();
  await expect(page.locator("details")).toContainText("하루 전");
  await page.getByRole("button", { name: /더보기/ }).click();
  await page.getByPlaceholder("지금 조건을 이름 붙여 저장 (예: 강남·자차·즉시가능)").fill("금요일 성동 백업");
  await page.getByRole("button", { name: "지금 조건 저장", exact: true }).click();
  await page.getByRole("button", { name: "조건 초기화", exact: true }).first().click();
  await expect(rows).toHaveCount(4);
  await page.getByRole("button", { name: "금요일 성동 백업", exact: true }).click();
  await expect(kind).toHaveValue("backup");
  await expect(query).toHaveValue("성동 금요일 세단");
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.getByPlaceholder("지금 조건을 이름 붙여 저장 (예: 강남·자차·즉시가능)")).not.toBeVisible();
  await page.locator("details summary").click();
  await page.screenshot({ path: "/tmp/ong-pool-matching-desktop.png", fullPage: true });

  failSummary = true;
  await page.reload();
  await kind.selectOption("unregistered");
  await expect(page.getByRole("alert").filter({ hasText: "희망 조건을 끝까지 확인하지 못했어요" })).toBeVisible();
  await expect(rows).toHaveCount(0);
  failSummary = false;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAccessibleName("미등록후보 지원자 상세 열기");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(kind).toBeVisible();
  await expect(query).toBeVisible();
  await page.screenshot({ path: "/tmp/ong-pool-matching-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  expect(unexpectedWrites).toEqual([]);
});
