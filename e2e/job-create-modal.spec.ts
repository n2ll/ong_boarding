import { expect, test, type Page, type Route } from "@playwright/test";

const API_FIXTURES: Record<string, unknown> = {
  "GET /api/admin/confirm/pending": { pending: [], total: 0 },
  "GET /api/admin/notifications": {
    counts: { inbox: 0, interventions: 0, aiDisabled: false },
    items: [],
  },
  "GET /api/admin/jobs?status=all": { jobs: [] },
  "GET /api/admin/agent/kill-switch": {
    mode: "draft",
    disabled: false,
    env_forced: false,
    updated_at: null,
  },
  "GET /api/admin/clients": {
    data: [
      {
        id: 1,
        name: "E2E 화주사",
        client_type: "general",
        uses_slots: true,
        active: true,
      },
    ],
  },
  "GET /api/admin/branches": {
    data: [{ id: 11, name: "E2E 지점", client_id: 1, active: true }],
  },
  "GET /api/admin/site-managers": { data: [] },
};

async function fulfillJson(route: Route, value: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
  });
}

async function installControlledNetwork(page: Page) {
  const apiRequests: string[] = [];
  const blockedRequests: string[] = [];

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isLocalApp = url.hostname === "127.0.0.1" || url.hostname === "localhost";

    if (
      url.hostname === "cdn.jsdelivr.net"
      && url.pathname.endsWith("/pretendardvariable.min.css")
    ) {
      await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      return;
    }

    if ((url.protocol === "http:" || url.protocol === "https:") && !isLocalApp) {
      blockedRequests.push(`${request.method()} ${url.href}`);
      await route.abort("blockedbyclient");
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    const key = `${request.method()} ${url.pathname}${url.search}`;
    apiRequests.push(key);
    if (Object.prototype.hasOwnProperty.call(API_FIXTURES, key)) {
      await fulfillJson(route, API_FIXTURES[key]);
      return;
    }

    blockedRequests.push(key);
    await route.abort("blockedbyclient");
  });

  return { apiRequests, blockedRequests };
}

function expectThumbInsideTrack(
  track: { x: number; y: number; width: number; height: number },
  thumb: { x: number; y: number; width: number; height: number },
) {
  expect(thumb.x).toBeGreaterThanOrEqual(track.x);
  expect(thumb.y).toBeGreaterThanOrEqual(track.y);
  expect(thumb.x + thumb.width).toBeLessThanOrEqual(track.x + track.width);
  expect(thumb.y + thumb.height).toBeLessThanOrEqual(track.y + track.height);
}

test("공고 등록 모달의 메모 우선 입력과 차량 토글이 정상 동작한다", async ({ page }) => {
  const network = await installControlledNetwork(page);

  await page.goto("/jobs");
  await page.getByRole("button", { name: "새 공고", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "새 공고 등록" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("배송 스케줄이나 라인 메모를 붙여넣으면 AI가 공고와 필수 정보를 정리합니다.");

  const memo = dialog.getByRole("textbox", { name: "받은 내용을 그대로 붙여넣어 주세요" });
  const generateButton = dialog.getByRole("button", { name: "AI 초안 생성" });
  await expect(memo).toBeFocused();
  await expect(generateButton).toBeDisabled();
  await memo.fill("성수 물류센터에서 강남권 배송, 오전 7시 시작, 3명 모집");
  await expect(generateButton).toBeEnabled();

  await expect(dialog.getByRole("heading", { name: "이번 공고의 근무 위치" })).toBeVisible();

  const vehicleSwitch = dialog.getByRole("switch", { name: "차량(이륜/사륜) 필요" });
  const thumb = vehicleSwitch.locator('[data-slot="switch-thumb"]');
  await vehicleSwitch.scrollIntoViewIfNeeded();
  await expect(vehicleSwitch).toBeChecked();

  const checkedTrackBox = await vehicleSwitch.boundingBox();
  const checkedThumbBox = await thumb.boundingBox();
  expect(checkedTrackBox).not.toBeNull();
  expect(checkedThumbBox).not.toBeNull();
  expectThumbInsideTrack(checkedTrackBox!, checkedThumbBox!);

  await vehicleSwitch.click();
  await expect(vehicleSwitch).not.toBeChecked();
  await expect.poll(async () => (await thumb.boundingBox())?.x).toBeLessThan(checkedThumbBox!.x);

  const uncheckedTrackBox = await vehicleSwitch.boundingBox();
  const uncheckedThumbBox = await thumb.boundingBox();
  expect(uncheckedTrackBox).not.toBeNull();
  expect(uncheckedThumbBox).not.toBeNull();
  expectThumbInsideTrack(uncheckedTrackBox!, uncheckedThumbBox!);

  await expect.poll(() => [...new Set(network.apiRequests)].sort()).toEqual(Object.keys(API_FIXTURES).sort());
  expect(network.blockedRequests).toEqual([]);
});
