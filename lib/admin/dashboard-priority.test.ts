import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type PriorityItem = {
  id: string;
  urgency: "blocker" | "critical" | "attention";
  ageMinutes?: number | null;
};

type GatewayPresentation = {
  tone: "healthy" | "attention" | "blocker";
  label: string;
  urgent: {
    urgency: "attention" | "blocker";
    ageMinutes: number | null;
    title: string;
    desc: string;
  } | null;
};

type DashboardPriorityModule = {
  isDashboardPrimaryPriority?: (
    sourceState: "loading" | "error" | "ready",
    index: number,
  ) => boolean;
  orderDashboardUrgentItems?: <T extends PriorityItem>(items: readonly T[]) => T[];
  dashboardQueuePreview?: <T>(items: readonly T[], limit?: number) => {
    visible: T[];
    remaining: number;
  };
  oldestUntouchedReplyDays?: (
    items: readonly {
      agent_stage?: string | null;
      last_message_at?: string | null;
      created_at?: string | null;
    }[],
    now: number,
  ) => number | null;
  dashboardUrgencyLabel?: (item: {
    urgency: PriorityItem["urgency"];
    priorityLabel?: string;
  }) => string;
  dashboardGatewayPresentation?: (input: {
    response?: {
      data?: {
        device_id: string;
        last_seen_at: string | null;
        pending_count: number;
      }[];
    };
    error?: unknown;
    now: number;
  }) => GatewayPresentation | null;
};

async function loadModule(): Promise<DashboardPriorityModule> {
  try {
    return await import(new URL("./dashboard-priority.ts", import.meta.url).href) as DashboardPriorityModule;
  } catch {
    return {};
  }
}

test("dashboard claims a global first priority only after every urgency source is ready", async () => {
  const { isDashboardPrimaryPriority } = await loadModule();

  assert.equal(typeof isDashboardPrimaryPriority, "function");
  assert.equal(isDashboardPrimaryPriority!("ready", 0), true);
  assert.equal(isDashboardPrimaryPriority!("ready", 1), false);
  assert.equal(isDashboardPrimaryPriority!("loading", 0), false);
  assert.equal(isDashboardPrimaryPriority!("error", 0), false);
});

test("blocking work stays ahead of older non-blocking work", async () => {
  const { orderDashboardUrgentItems } = await loadModule();

  assert.equal(typeof orderDashboardUrgentItems, "function");
  assert.deepEqual(orderDashboardUrgentItems!([
    { id: "old-critical", urgency: "critical", ageMinutes: 84 * 24 * 60 },
    { id: "ai-off", urgency: "blocker", ageMinutes: null },
  ]).map((item) => item.id), ["ai-off", "old-critical"]);
});

test("work with the same urgency is ordered by longest wait", async () => {
  const { orderDashboardUrgentItems } = await loadModule();

  assert.equal(typeof orderDashboardUrgentItems, "function");
  assert.deepEqual(orderDashboardUrgentItems!([
    { id: "77-days", urgency: "critical", ageMinutes: 77 * 24 * 60 },
    { id: "36-days", urgency: "critical", ageMinutes: 36 * 24 * 60 },
    { id: "84-days", urgency: "critical", ageMinutes: 84 * 24 * 60 },
  ]).map((item) => item.id), ["84-days", "77-days", "36-days"]);
});

test("priority ordering does not mutate the source list", async () => {
  const { orderDashboardUrgentItems } = await loadModule();
  const items: PriorityItem[] = [
    { id: "attention", urgency: "attention", ageMinutes: 10 },
    { id: "critical", urgency: "critical", ageMinutes: 20 },
  ];

  assert.equal(typeof orderDashboardUrgentItems, "function");
  orderDashboardUrgentItems!(items);
  assert.deepEqual(items.map((item) => item.id), ["attention", "critical"]);
});

test("dashboard queue preview shows only the first five items and reports the remainder", async () => {
  const { dashboardQueuePreview } = await loadModule();
  const items = Array.from({ length: 8 }, (_, index) => ({ id: index + 1 }));

  assert.equal(typeof dashboardQueuePreview, "function");
  assert.deepEqual(dashboardQueuePreview!(items), {
    visible: items.slice(0, 5),
    remaining: 3,
  });
});

test("dashboard queue preview keeps short queues intact without mutating the source", async () => {
  const { dashboardQueuePreview } = await loadModule();
  const items = [{ id: 1 }, { id: 2 }];

  assert.equal(typeof dashboardQueuePreview, "function");
  assert.deepEqual(dashboardQueuePreview!(items), { visible: items, remaining: 0 });
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
});

test("reply age ignores older conversations that a manager already started", async () => {
  const { oldestUntouchedReplyDays } = await loadModule();
  const now = Date.parse("2026-08-21T00:00:00.000Z");

  assert.equal(typeof oldestUntouchedReplyDays, "function");
  assert.equal(oldestUntouchedReplyDays!([
    { agent_stage: "paused", last_message_at: "2026-05-01T00:00:00.000Z" },
    { agent_stage: "screening", last_message_at: "2026-08-19T00:00:00.000Z" },
  ], now), 2);
  assert.equal(oldestUntouchedReplyDays!([
    { agent_stage: "paused", last_message_at: "2026-05-01T00:00:00.000Z" },
  ], now), null);
});

test("priority labels can distinguish immediate work from aged critical work", async () => {
  const { dashboardUrgencyLabel } = await loadModule();

  assert.equal(typeof dashboardUrgencyLabel, "function");
  assert.equal(dashboardUrgencyLabel!({ urgency: "critical" }), "장기 지연");
  assert.equal(dashboardUrgencyLabel!({ urgency: "critical", priorityLabel: "우선 처리" }), "우선 처리");
});

test("a failed heartbeat request becomes blocking dashboard work", async () => {
  const { dashboardGatewayPresentation } = await loadModule();

  assert.equal(typeof dashboardGatewayPresentation, "function");
  const result = dashboardGatewayPresentation!({
    error: new Error("offline"),
    now: Date.parse("2026-08-31T12:00:00.000Z"),
  });

  assert.equal(result?.tone, "blocker");
  assert.equal(result?.urgent?.urgency, "blocker");
  assert.equal(result?.urgent?.ageMinutes, null);
});

test("a loaded heartbeat response without a device becomes blocking dashboard work", async () => {
  const { dashboardGatewayPresentation } = await loadModule();

  assert.equal(typeof dashboardGatewayPresentation, "function");
  const result = dashboardGatewayPresentation!({
    response: { data: [] },
    now: Date.parse("2026-08-31T12:00:00.000Z"),
  });

  assert.equal(result?.tone, "blocker");
  assert.equal(result?.urgent?.urgency, "blocker");
});

test("a heartbeat silent for exactly ten minutes becomes blocking dashboard work", async () => {
  const { dashboardGatewayPresentation } = await loadModule();
  const now = Date.parse("2026-08-31T12:00:00.000Z");

  assert.equal(typeof dashboardGatewayPresentation, "function");
  const result = dashboardGatewayPresentation!({
    response: {
      data: [{
        device_id: "gateway-1",
        last_seen_at: "2026-08-31T11:50:00.000Z",
        pending_count: 0,
      }],
    },
    now,
  });

  assert.equal(result?.tone, "blocker");
  assert.equal(result?.urgent?.urgency, "blocker");
  assert.equal(result?.urgent?.ageMinutes, 10);
});

test("a connected gateway with queued messages becomes attention work", async () => {
  const { dashboardGatewayPresentation } = await loadModule();
  const now = Date.parse("2026-08-31T12:00:00.000Z");

  assert.equal(typeof dashboardGatewayPresentation, "function");
  const result = dashboardGatewayPresentation!({
    response: {
      data: [{
        device_id: "gateway-1",
        last_seen_at: "2026-08-31T11:51:00.000Z",
        pending_count: 3,
      }],
    },
    now,
  });

  assert.equal(result?.tone, "attention");
  assert.equal(result?.urgent?.urgency, "attention");
  assert.equal(result?.urgent?.ageMinutes, 9);
});

test("a connected gateway without queued messages adds no dashboard work", async () => {
  const { dashboardGatewayPresentation } = await loadModule();
  const now = Date.parse("2026-08-31T12:00:00.000Z");

  assert.equal(typeof dashboardGatewayPresentation, "function");
  const result = dashboardGatewayPresentation!({
    response: {
      data: [{
        device_id: "gateway-1",
        last_seen_at: "2026-08-31T11:59:00.000Z",
        pending_count: 0,
      }],
    },
    now,
  });

  assert.equal(result?.tone, "healthy");
  assert.equal(result?.urgent, null);
});

test("an invalid or missing heartbeat timestamp is treated as no signal", async () => {
  const { dashboardGatewayPresentation } = await loadModule();
  const now = Date.parse("2026-08-31T12:00:00.000Z");

  assert.equal(typeof dashboardGatewayPresentation, "function");
  for (const lastSeenAt of ["not-a-date", null]) {
    const result = dashboardGatewayPresentation!({
      response: {
        data: [{
          device_id: "gateway-1",
          last_seen_at: lastSeenAt,
          pending_count: 0,
        }],
      },
      now,
    });

    assert.equal(result?.tone, "blocker");
    assert.equal(result?.label, "문자 발송폰 신호 없음");
    assert.equal(result?.urgent?.urgency, "blocker");
  }
});

test("the primary heartbeat action names and exposes its refresh progress", () => {
  const dashboard = readFileSync(new URL("../../components/Dashboard.tsx", import.meta.url), "utf8");

  assert.match(dashboard, /isValidating: heartbeatValidating/);
  assert.match(dashboard, /isLoading=\{urgent\[0\]\.action === "retry-heartbeat" && heartbeatValidating\}/);
  assert.match(dashboard, /urgent\[0\]\.action === "retry-heartbeat" \? "문자폰 상태 다시 확인"/);
});
