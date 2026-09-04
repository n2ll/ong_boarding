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

async function installControlledNetwork(
  page: Page,
  generatePosting?: (route: Route) => Promise<void>,
  exposurePreview?: (route: Route) => Promise<void>,
  registerJob?: (route: Route) => Promise<void>,
) {
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
    if (key === "POST /api/admin/jobs/generate-posting" && generatePosting) {
      await generatePosting(route);
      return;
    }
    if (key === "POST /api/admin/jobs" && registerJob) {
      await registerJob(route);
      return;
    }
    if (url.pathname === "/api/admin/exposure" && exposurePreview) {
      await exposurePreview(route);
      return;
    }
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

test("AI가 찾지 못한 필수 정보만 묻고 답변을 재생성 요청에 반영한다", async ({ page }) => {
  const generationRequests: Record<string, unknown>[] = [];
  const network = await installControlledNetwork(page, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    generationRequests.push(body);
    await fulfillJson(route, {
      ok: true,
      source: "ai",
      posting: {
        title: "성수 새벽 배송 모집",
        fields: {
          pay: body.pay_info || "",
          schedule: "평일 오전 3시~9시",
          pickupAddress: body.pickup_address || "성수 물류센터 3번 게이트",
          dropoffAddress: body.dropoff_address || "",
          capacity: body.capacity || null,
          vehicleRequired: true,
          workPeriod: "정기",
          slotKeys: ["평일오전"],
        },
        albamon: { body: `성수 새벽 배송 모집\n${body.pay_info || "급여 확인 필요"}` },
        sms: { body: "성수 새벽 배송 모집 안내" },
      },
    });
  });

  await page.goto("/jobs");
  await page.getByRole("button", { name: "새 공고", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "새 공고 등록" });
  await dialog.getByRole("textbox", { name: "받은 내용을 그대로 붙여넣어 주세요" }).fill(
    "성수 물류센터에서 평일 새벽 배송",
  );
  await dialog.getByRole("button", { name: "AI 초안 생성" }).click();

  const followup = dialog.getByRole("region", { name: "AI가 확인할 내용" });
  await expect(followup).toBeVisible();
  await expect(followup.getByLabel("상차지·집결지")).toHaveCount(0);
  await expect(followup.getByLabel("모집 인원")).toBeVisible();
  await expect(followup.getByLabel("배송 권역·마지막 경유지")).toBeVisible();
  await expect(followup.getByLabel("급여·정산 안내")).toBeVisible();

  const updateButton = followup.getByRole("button", { name: "답변 반영해 초안 업데이트" });
  await expect(updateButton).toBeDisabled();
  await followup.getByLabel("모집 인원").fill("4");
  await followup.getByLabel("배송 권역·마지막 경유지").fill("하남 미사 일대 · 종료 미사역");
  await followup.getByLabel("급여·정산 안내").fill("건당 3,500원 · 매주 금요일 정산");
  await expect(updateButton).toBeEnabled();
  await updateButton.click();

  await expect(followup).toHaveCount(0);
  expect(generationRequests).toHaveLength(2);
  expect(generationRequests[1]).toMatchObject({
    capacity: 4,
    pickup_address: "성수 물류센터 3번 게이트",
    dropoff_address: "하남 미사 일대 · 종료 미사역",
    pay_info: "건당 3,500원 · 매주 금요일 정산",
  });
  expect(network.blockedRequests).toEqual([]);
});

test("추천 노출 조건을 한 번에 적용하고 관리자가 바로 수정할 수 있다", async ({ page }) => {
  const network = await installControlledNetwork(page, undefined, async (route) => {
    if (route.request().method() === "GET") {
      await fulfillJson(route, {
        sidos: [],
        availabilities: [],
        sigunguGroups: [],
        slots: [
          { key: "평일오전", label: "평일 오전", count: 8 },
          { key: "평일오후", label: "평일 오후", count: 0 },
          { key: "주말오전", label: "주말 오전", count: 0 },
          { key: "주말오후", label: "주말 오후", count: 0 },
        ],
        unknown: { sido: 0, sigungu: 0, slot: 2, slot_partial: 0 },
      });
      return;
    }
    await fulfillJson(route, {
      count: 20,
      total: 30,
      sample: [],
      visible_count: 20,
      sms_eligible_count: 14,
      recommendations: [],
      suggested_audience: {
        rule: { vehicle: ["있음"], slot: ["평일오전", "미확인"], radiusKm: 10, radiusIncludeUnknown: true },
        reasons: ["차량 보유자", "희망 시간대 일치·미확인 포함", "근무 위치 10km 이내·주소 미확인 포함"],
        visible_count: 16,
        sms_eligible_count: 12,
        contact_target: 12,
      },
    });
  });

  await page.goto("/jobs");
  await page.getByRole("button", { name: "새 공고", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "새 공고 등록" });
  await dialog.getByRole("button", { name: "직접 작성" }).click();
  const applySuggestion = dialog.getByRole("button", { name: "추천 조건 적용" });
  await expect(applySuggestion).toBeVisible();
  await expect(dialog).toContainText("추천 적용 시 맞춤 링크 16명 · 현재 문자 안내 가능 12명");
  await applySuggestion.click();

  await expect(dialog.getByRole("button", { name: /지정 노출/ })).toHaveAttribute("aria-pressed", "true");
  for (const label of ["평일 오전 8", "미확인 2", "있음", "10km"]) {
    await expect(dialog.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await expect(dialog.getByRole("checkbox", { name: /주소를 몰라 거리를 못 재는 분도 포함/ })).toBeChecked();
  await dialog.getByRole("button", { name: "평일 오전 8", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "평일 오전 8", exact: true })).toHaveAttribute("aria-pressed", "false");
  await dialog.getByRole("spinbutton", { name: "모집 인원" }).fill("3");
  await expect(dialog).toContainText("추천을 적용한 뒤 공고 정보가 바뀌었어요");
  await expect(dialog.getByRole("button", { name: "추천 조건 다시 적용" })).toBeVisible();
  expect(network.blockedRequests).toEqual([]);
});

test("등록 완료 뒤 자동 문자 조회 없이 추천 명단 확인으로 이어진다", async ({ page }) => {
  const registrationRequests: Record<string, unknown>[] = [];
  const network = await installControlledNetwork(
    page,
    async (route) => {
      await fulfillJson(route, {
        ok: true,
        source: "ai",
        posting: {
          title: "성수 오전 배송 모집",
          fields: {
            pay: "건당 3,500원 · 매주 금요일 정산",
            schedule: "평일 오전 7시~12시",
            pickupAddress: "성수 물류센터 3번 게이트",
            dropoffAddress: "강남 일대 · 종료 강남역",
            capacity: 3,
            vehicleRequired: true,
            workPeriod: "정기",
            slotKeys: ["평일오전"],
          },
          albamon: { body: "성수 오전 배송 모집\n평일 오전 7시~12시" },
          sms: { body: "[옹고잉] 성수 오전 배송 공고를 확인해 주세요. #{맞춤링크}" },
        },
      });
    },
    undefined,
    async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      registrationRequests.push(payload);
      await fulfillJson(route, {
        job: {
          ...payload,
          id: 77,
          title: "성수 오전 배송 모집",
          body: "성수 오전 배송 모집\n평일 오전 7시~12시",
          branch: null,
          branch_id: null,
          client_id: null,
          status: "active",
          recruit_mode: "internal",
          exposure: "all",
          exposure_rule: null,
          vehicle_required: true,
          capacity: 3,
          created_at: "2026-09-04T00:00:00.000Z",
          closed_at: null,
          work_period: "정기",
          closes_at: null,
          counts: {},
          confirmed_count: 0,
          review_ready_count: 0,
          interest_count: 0,
          tracking_submission_count: 0,
          pickup_address: "성수 물류센터 3번 게이트",
          dropoff_address: "강남 일대 · 종료 강남역",
          pickup_lat: 37.5445,
          dropoff_lat: 37.4979,
        },
      });
    },
  );

  await page.goto("/jobs");
  await page.getByRole("button", { name: "새 공고", exact: true }).click();

  const createDialog = page.getByRole("dialog", { name: "새 공고 등록" });
  await createDialog.getByRole("textbox", { name: "받은 내용을 그대로 붙여넣어 주세요" }).fill(
    "성수 물류센터에서 강남권 배송, 평일 오전 7시 시작, 3명, 건당 3,500원",
  );
  await createDialog.getByRole("button", { name: "AI 초안 생성" }).click();
  await createDialog.getByRole("button", { name: "이 내용으로 공고 등록" }).click();

  const completionDialog = page.getByRole("dialog", { name: "공고 등록 완료" });
  await expect(completionDialog).toBeVisible();
  await expect(completionDialog).toContainText("추천 근거 확인 → 대상 선택 → 공고 노출 → 문자 검토");
  const recommendationButton = completionDialog.getByRole("button", { name: "추천 명단 확인" });
  await expect(recommendationButton).toBeVisible();

  expect(registrationRequests).toHaveLength(1);
  expect(registrationRequests[0]).toMatchObject({
    recruit_mode: "internal",
    capacity: 3,
    pickup_address: "성수 물류센터 3번 게이트",
    dropoff_address: "강남 일대 · 종료 강남역",
    pay_info: "건당 3,500원 · 매주 금요일 정산",
  });
  expect(network.apiRequests.some((request) => request.includes("/announce-targets"))).toBe(false);
  expect(network.blockedRequests).toEqual([]);

  const [pipelineRequest] = await Promise.all([
    page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/pipeline" && url.searchParams.get("job") === "77";
    }),
    recommendationButton.click(),
  ]);
  expect(new URL(pipelineRequest.url()).searchParams.get("job")).toBe("77");
});
