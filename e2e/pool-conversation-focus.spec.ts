import { expect, test, type Page, type Route } from "@playwright/test";

const firstTitle = "성수 오전 배송";
const secondTitle = "강남 오후 배송";

function job(id: number, title: string, interested: boolean) {
  return {
    id, title, interested, body: null, branch: "서울", slot: "평일 오전",
    start_date: null, vehicle_required: false, pickup_address: null,
    pay_type: "일당", pay_amount: 100000, pay_info: null, work_period: "단기",
    closes_at: null, expired: false, distance_km: null, notified: false,
    fit: "ok", fit_reasons: [], status: interested ? "talking" : "none",
  };
}

async function fulfillJson(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) });
}

async function installPoolNetwork(page: Page, options: {
  focusStatus?: number;
  focusResult?: number | null;
  engage?: string;
  canSwitch?: boolean;
  targetStatus?: string;
  targetExpired?: boolean;
  hiddenFocus?: boolean;
} = {}) {
  const state = {
    name: "테스트", availability: null, own_vehicle: "없음",
    focus_job_id: options.hiddenFocus ? null as number | null : 11 as number | null,
    has_conversation_focus: true, can_switch_focus: options.canSwitch ?? true,
    jobs: [job(11, firstTitle, true), job(22, secondTitle, false)],
  };
  if (options.targetStatus) {
    state.jobs[1].status = options.targetStatus;
    state.jobs[1].interested = options.targetStatus !== "ended";
  }
  if (options.targetExpired) state.jobs[1].expired = true;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const blocked: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "cdn.jsdelivr.net" && url.pathname.endsWith("/pretendardvariable.min.css")) {
      await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      return;
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      blocked.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/pool/focus-test") {
      await fulfillJson(route, state);
      return;
    }
    if (request.method() === "POST" && ["/api/pool/focus-test/interest", "/api/pool/focus-test/focus"].includes(url.pathname)) {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/interest")) {
        state.jobs[1].interested = true;
        state.jobs[1].status = "interested";
        await fulfillJson(route, { ok: true, engage: "skipped:interest_only" });
      } else if (options.focusStatus && options.focusStatus !== 200) {
        await fulfillJson(route, { error: "이전 문자 처리를 확인 중이에요. 잠시 후 다시 확인해 주세요." }, options.focusStatus);
      } else {
        state.jobs[1].interested = true;
        state.jobs[1].status = "talking";
        state.focus_job_id = options.focusResult === undefined ? 22 : options.focusResult;
        state.has_conversation_focus = state.focus_job_id !== null;
        await fulfillJson(route, { focus_job_id: state.focus_job_id, engage: options.engage ?? "engaged" });
      }
      return;
    }
    blocked.push(`${request.method()} ${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  return { state, writes, blocked };
}

function card(page: Page, title: string) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  test(`관심만 전달한 공고를 나중에 문자 대화로 선택하고 새로고침해도 유지한다 (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const network = await installPoolNetwork(page);
    await page.goto("/p/focus-test");
    const first = card(page, firstTitle);
    const second = card(page, secondTitle);
    await expect(first.getByText("현재 문자 대화", { exact: true })).toBeVisible();
    await second.getByRole("button", { name: "관심 있어요", exact: true }).click();
    await expect(second.getByRole("button", { name: "이 공고로 문자 대화", exact: true })).toBeVisible();
    if (viewport.width === 390) await page.screenshot({ path: "/tmp/pool-focus-mobile-choice.png", fullPage: true });
    await second.getByRole("button", { name: "관심만 전달", exact: true }).click();
    await expect(second).toContainText("관심을 매니저에게 전달했어요");
    await expect(first.getByText("현재 문자 대화", { exact: true })).toBeVisible();
    expect(network.writes).toHaveLength(1);
    expect(network.writes[0]).toMatchObject({ path: "/api/pool/focus-test/interest", body: { job_id: 22, interest_only: true } });
    expect(network.writes[0].body.action_id).toEqual(expect.any(String));

    await page.reload();
    await expect(first.getByText("현재 문자 대화", { exact: true })).toBeVisible();
    await second.getByRole("button", { name: "이 공고로 문자 대화", exact: true }).click();
    expect(network.writes).toHaveLength(1);
    await second.getByRole("button", { name: "네, 문자 대화 바꿀게요", exact: true }).click();
    await expect(second.getByText("현재 문자 대화", { exact: true })).toBeVisible();
    await expect(first.getByText("현재 문자 대화", { exact: true })).toHaveCount(0);
    expect(network.writes[1]).toMatchObject({ path: "/api/pool/focus-test/focus", body: { job_id: 22 } });
    await page.reload();
    await expect(second.getByText("현재 문자 대화", { exact: true })).toBeVisible();
    await expect(first.getByRole("button", { name: "진행 내용이 저장돼 있어요" })).toBeDisabled();
    await expect(first.getByText("이야기 중", { exact: true })).toHaveCount(0);
    await expect(second.getByRole("button", { name: "이 자리로 이야기하고 있어요" })).toBeDisabled();
    expect(network.blocked).toEqual([]);
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(horizontalOverflow).toBe(false);
    if (viewport.width === 390) await page.screenshot({ path: "/tmp/pool-focus-mobile-result.png", fullPage: true });
  });

  test(`새 관심 공고로 바로 전환할 때 focus 요청만 보내고 409면 기존 공고를 유지한다 (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const network = await installPoolNetwork(page, { focusStatus: 409 });
    await page.goto("/p/focus-test");
    const first = card(page, firstTitle);
    const second = card(page, secondTitle);
    await second.getByRole("button", { name: "관심 있어요", exact: true }).click();
    await second.getByRole("button", { name: "이 공고로 문자 대화", exact: true }).click();
    await expect(second.getByRole("alert")).toContainText("이전 문자 처리를 확인 중");
    await expect(first.getByText("현재 문자 대화", { exact: true })).toBeVisible();
    await expect(second.getByText("현재 문자 대화", { exact: true })).toHaveCount(0);
    expect(network.writes).toHaveLength(1);
    expect(network.writes[0].path).toBe("/api/pool/focus-test/focus");
    await page.reload();
    await expect(first.getByText("현재 문자 대화", { exact: true })).toBeVisible();
    await expect(second.getByRole("button", { name: "관심 있어요", exact: true })).toBeEnabled();
    expect(network.blocked).toEqual([]);
  });
}

for (const focusResult of [11, null]) {
  test(`이전 전환 재시도 응답의 현재 공고 ${focusResult}를 화면에 반영한다`, async ({ page }) => {
    const network = await installPoolNetwork(page, { focusResult, engage: "off" });
    await page.goto("/p/focus-test");
    const second = card(page, secondTitle);
    await second.getByRole("button", { name: "관심 있어요", exact: true }).click();
    await second.getByRole("button", { name: "이 공고로 문자 대화", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("현재 문자 대화");
    await expect(second.getByText("현재 문자 대화", { exact: true })).toHaveCount(0);
    await expect(card(page, firstTitle).getByText("현재 문자 대화", { exact: true })).toHaveCount(focusResult === 11 ? 1 : 0);
    expect(network.blocked).toEqual([]);
  });
}

test("같은 공고로 돌아온 이전 전환 요청은 현재 대화만 안내한다", async ({ page }) => {
  const network = await installPoolNetwork(page, { focusResult: 22, engage: "superseded" });
  await page.goto("/p/focus-test");
  const second = card(page, secondTitle);
  await second.getByRole("button", { name: "관심 있어요", exact: true }).click();
  await second.getByRole("button", { name: "이 공고로 문자 대화", exact: true }).click();
  await expect(second.getByRole("status")).toHaveText(`현재 문자 대화는 ‘${secondTitle}’예요. 이전 요청의 처리 결과를 확인했어요.`);
  await expect(second.getByText("현재 문자 대화", { exact: true })).toBeVisible();
  await expect(second.getByRole("status")).not.toContainText("아침");
  expect(network.writes).toHaveLength(1);
  expect(network.blocked).toEqual([]);
});

for (const options of [{ canSwitch: false }, { targetStatus: "paused" }, { targetStatus: "ended" }, { targetExpired: true }]) {
  test(`전환할 수 없는 공고에는 전환 버튼이 없다 ${JSON.stringify(options)}`, async ({ page }) => {
    await installPoolNetwork(page, options);
    await page.goto("/p/focus-test");
    const second = card(page, secondTitle);
    await expect(second.getByRole("heading", { name: secondTitle })).toBeVisible();
    const interest = second.getByRole("button", { name: /관심 있어요/ });
    if (await interest.count() > 0 && await interest.isEnabled()) await interest.click();
    await expect(second.getByRole("button", { name: "이 공고로 문자 대화", exact: true })).toHaveCount(0);
  });
}


test("503 전환 재시도는 같은 요청 키를 쓰고 관심 저장으로 바꾸지 않는다", async ({ page }) => {
  const options = { focusStatus: 503 };
  const network = await installPoolNetwork(page, options);
  await page.goto("/p/focus-test");
  const second = card(page, secondTitle);
  await second.getByRole("button", { name: "관심 있어요", exact: true }).click();
  await second.getByRole("button", { name: "이 공고로 문자 대화", exact: true }).click();
  await expect(second.getByRole("alert")).toBeVisible();
  await expect(second.getByRole("button", { name: "관심만 전달", exact: true })).toBeDisabled();
  options.focusStatus = 200;
  await second.getByRole("button", { name: "다시 시도하기", exact: true }).click();
  await expect(second.getByText("현재 문자 대화", { exact: true })).toBeVisible();
  expect(network.writes).toHaveLength(2);
  expect(network.writes[1]).toEqual(network.writes[0]);
  expect(network.blocked).toEqual([]);
});

test("목록에서 보이지 않는 기존 대화가 있어도 관심과 문자 대화 선택을 나눈다", async ({ page }) => {
  const network = await installPoolNetwork(page, { hiddenFocus: true });
  await page.goto("/p/focus-test");
  const second = card(page, secondTitle);
  await second.getByRole("button", { name: "관심 있어요", exact: true }).click();
  await expect(second.getByRole("button", { name: "관심만 전달", exact: true })).toBeVisible();
  await expect(second.getByRole("button", { name: "이 공고로 문자 대화", exact: true })).toBeVisible();
  await expect(page.getByText("현재 문자 대화", { exact: true })).toHaveCount(0);
  expect(network.writes).toHaveLength(0);
});

for (const scenario of [
  { engage: "engaged", expected: "안내 문자를 보냈어요" },
  { engage: "queued", expected: "안내 문자는 아침에" },
  { engage: "drafted", expected: "매니저가 내용을 확인한 뒤" },
  { engage: "off", expected: "매니저가 내용을 확인한 뒤" },
  { engage: "off", targetStatus: "talking", expected: "궁금한 점을 받으신 문자에 답장" },
]) {
  test(`전환 결과 ${scenario.engage}/${scenario.targetStatus ?? "new"}에 맞는 다음 행동을 안내한다`, async ({ page }) => {
    const network = await installPoolNetwork(page, scenario);
    await page.goto("/p/focus-test");
    const second = card(page, secondTitle);
    if (scenario.targetStatus) {
      await second.getByRole("button", { name: "이 공고로 문자 대화", exact: true }).click();
      await second.getByRole("button", { name: "네, 문자 대화 바꿀게요", exact: true }).click();
    } else {
      await second.getByRole("button", { name: "관심 있어요", exact: true }).click();
      await second.getByRole("button", { name: "이 공고로 문자 대화", exact: true }).click();
    }
    await expect(second.getByRole("status")).toContainText(secondTitle);
    await expect(second.getByRole("status")).toContainText(scenario.expected);
    expect(network.writes).toHaveLength(1);
    expect(network.writes[0].path).toBe("/api/pool/focus-test/focus");
    expect(network.blocked).toEqual([]);
  });
}
