import { expect, test, type Page } from "@playwright/test";

async function installRecruitmentFixtures(page: Page, baseURL: string) {
  const session = { access_token: "consultation-fixture", refresh_token: "consultation-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  await page.context().addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL }]);
  await page.routeWebSocket("**/realtime/v1/**", () => {});
  const at = new Date().toISOString();
  const people = [7, 8].map(id => ({ id, name: `가상모집${id}`, phone: `0100000000${id}`, source: "homepage", marketing_consent: false,
    own_vehicle: null, status: "스크리닝 중", agent_stage: null, created_at: at, job_links: [] }));
  const job = { id: 11, title: "가상 예비 배송 모집", status: "active", recruit_mode: "internal", exposure: "targeted" };
  const fixtures: Record<string, unknown> = {
    "/api/admin/applicants": { data: people },
    "/api/admin/jobs": { jobs: [job] },
    "/api/admin/branches": { data: [] },
    "/api/admin/notifications": { counts: { inbox: 0, interventions: 0, aiDisabled: true }, items: [] },
    "/api/admin/confirm/pending": { pending: [], total: 0 },
    "/api/admin/agent/handoffs": { by_category: {}, total: 0, handoffs: [] },
    "/api/admin/agent/kill-switch": { mode: "off", disabled: true, env_forced: false, updated_at: at,
      pilot_session: { mode: "pilot", applicant_ids: [99], job_ids: [12], started_at: at, expires_at: new Date(Date.now() + 3600000).toISOString() } },
    "/api/admin/exposure/impact": { total_pool: 2, jobs: [{ ...job, rule_conditions: 0, rule_labels: [], rule_matched: 0, include_count: 0, exclude_count: 0, linked: 0, pull_exposed: true }] },
  };
  const writes: Array<{ path: string; body: Record<string, any> }> = [];
  const unexpected: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.hostname === "cdn.jsdelivr.net" && path.endsWith("/pretendardvariable.min.css")) return route.fulfill({ contentType: "text/css", body: "" });
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) { unexpected.push(url.origin); return route.abort("blockedbyclient"); }
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/admin/pool-events/summary") return route.fulfill({ json: { summaryById: {} } });
    if (path === "/api/admin/ongmanaging/active-check") return route.fulfill({ json: { configured: true, checked: 2, active: [], unchecked: 0 } });
    if (request.method() === "GET" && fixtures[path]) return route.fulfill({ json: fixtures[path] });
    if (request.method() === "POST") {
      const body = request.postDataJSON(); writes.push({ path, body });
      if (path === "/api/admin/exposure/bulk") return route.fulfill({ json: { added: 2, non_targeted: [], flipped: [], rule_cleared: [] } });
      if (path.endsWith("/recruitment-contact-authorization")) return route.fulfill({ json: { reviewed_at: at,
        ...(body.mode === "authorize" ? { expires_at: new Date(Date.now() + 86400000).toISOString() } : {}),
        recipients: body.recipients.map((row: { applicant_id: number; phone: string }) => ({ ...row, name: `가상모집${row.applicant_id}`, state: body.mode === "authorize" ? "authorized" : "authorization_required" })) } });
      if (path === "/api/admin/messages/bulk-send") return route.fulfill({ json: { results: body.recipients.map((row: { applicant_id: number; phone: string }, index: number) => ({
        ...row, success: index === 0, state: index === 0 ? "recorded" : "unknown", deduplicated: false, recovery_pending: false,
        ...(index ? { error: "전송 결과 미확인" } : {}),
      })) } });
      if (path === "/api/admin/jobs/11/candidates") {
        const attempts = writes.filter(row => row.path === path).length;
        return route.fulfill({ status: attempts === 1 ? 500 : 200, json: attempts === 1 ? { error: "후보는 추가했지만 노출 확인이 필요합니다.", partial: true }
          : { added: 0, candidates: [], exposure_included: 1 } });
      }
    }
    unexpected.push(`${request.method()} ${path}`); return route.abort("blockedbyclient");
  });
  return { writes, unexpected, errors };
}

for (const width of [1280, 390]) test(`모집 연락 승인·발송 결과·후보 연결·활성 파일럿 보호 (${width}px)`, async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width, height: 900 });
  const state = await installRecruitmentFixtures(page, baseURL!);
  const writes = (suffix: string) => state.writes.filter(row => row.path.endsWith(suffix));
  await page.goto("/pipeline?view=list&job=11");
  await page.getByRole("checkbox", { name: "가상모집7 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "가상모집8 선택", exact: true }).check();
  await page.getByRole("button", { name: "2명에게 공고 노출", exact: true }).click();
  const exposure = page.getByRole("dialog", { name: "노출 대상 지정", exact: true });
  await exposure.getByRole("button", { name: "2명에게 공고 노출 (1)", exact: true }).click();
  await page.getByRole("button", { name: "안내 문자 검토", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "모집 연락 준비", exact: true });
  await expect(dialog).toBeVisible();
  expect(writes("bulk-send")).toHaveLength(0);
  await dialog.getByRole("textbox", { name: /안내 문구/ }).fill("안녕하세요 #{이름}님. 9월 22일 예비 배송 모집입니다. 가능 일정과 선탑 조건을 확인해주세요. #{맞춤링크}");
  await dialog.getByRole("button", { name: "명단·연락 근거 검토", exact: true }).click();
  await expect(dialog.getByText("원모집 연락 근거 확인 필요", { exact: false })).toHaveCount(2);
  await dialog.getByRole("textbox", { name: "확인한 원모집 연락 근거 (20자 이상)", exact: true }).fill("가상 검수용 원모집 설문 원장을 확인했습니다. 이번 공고 안내 목적입니다.");
  await dialog.getByRole("checkbox", { name: /선택 명단의 원모집 연락 근거/ }).check();
  await dialog.getByRole("button", { name: "이번 연락 근거 저장", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "검토한 2명 문자 발송", exact: true })).toBeEnabled();
  expect(writes("bulk-send")).toHaveLength(0);
  await page.mouse.move(1, 1);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
  await dialog.getByRole("button", { name: "검토한 2명 문자 발송", exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("button", { name: "검토한 2명 문자 발송", exact: true })).toBeInViewport();
  await page.screenshot({ path: `/tmp/recruitment-review-${width}.png`, animations: "disabled" });
  await dialog.getByRole("button", { name: "검토한 2명 문자 발송", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("후보 연결과 자동 응대 시작은 별도입니다");
  expect(writes("bulk-send")).toHaveLength(0);
  await confirm.getByRole("button", { name: "2명 발송", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "3. 발송 결과 · 기록 완료 1/2명" })).toBeVisible();
  await expect(dialog.getByText("가상모집8 · 발송 확인 필요", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(1);
  await dialog.getByRole("button", { name: "발송 완료 1명 후보 연결", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("문자 발송은 다시 하지 않고");
  await dialog.getByRole("button", { name: "발송 완료 1명 후보 연결 다시 확인", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "4. 후보 연결 완료 1명 · 제한 자동 응대" })).toBeVisible();
  await dialog.getByRole("button", { name: "현재 자동 응대 설정 확인", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("이미 제한 운영이 진행 중입니다");
  await expect(dialog.getByRole("button", { name: "선택 대상 확인 후 시작", exact: true })).toHaveCount(0);
  expect(writes("candidates").map(row => row.body)).toEqual([{ applicant_ids: [7] }, { applicant_ids: [7] }]);
  expect(writes("bulk-send")).toHaveLength(1);
  const approval = writes("recruitment-contact-authorization").find(row => row.body.mode === "authorize")!.body;
  const { mode: _mode, note: _note, ...approvedPayload } = approval;
  expect(writes("bulk-send")[0].body).toEqual(approvedPayload);
  expect(writes("kill-switch")).toHaveLength(0);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.mouse.move(1, 1);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
  await dialog.getByRole("status").scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("status")).toBeInViewport();
  await page.screenshot({ path: `/tmp/recruitment-result-${width}.png`, animations: "disabled" });
});
