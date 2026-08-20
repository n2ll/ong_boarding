import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

type Slot = "평일오전" | "평일오후" | "주말오전" | "주말오후";

type OverviewInput = {
  branches?: Array<{
    id: number;
    name: string;
    active: boolean;
    client_id: number | null;
    slot_capacity: Record<string, number> | null;
  }>;
  clients?: Array<{ id: number; name: string; uses_slots: boolean; active?: boolean }>;
  applicants?: Array<{
    id: number;
    status: string;
    branch?: string | null;
    branch1?: string | null;
    confirmed_branch?: string | null;
    work_hours?: string | null;
    confirmed_slot?: string | null;
  }>;
  slots: readonly Slot[];
  defaultCapacity: Record<Slot, number>;
  clientId?: number | null;
  errors?: Partial<Record<"branches" | "clients" | "applicants", unknown>>;
};

type OverviewModule = {
  buildSlotBoardOverview?: (input: OverviewInput) =>
    | { state: "loading" }
    | { state: "error"; sources: Array<"branches" | "clients" | "applicants"> }
    | {
        state: "ready";
        rows: Array<{
          branch: { id: number; name: string };
          cells: Array<{
            slot: Slot;
            capacity: number;
            confirmed: number;
            waiting: number;
            gap: number;
            capacitySource: "configured" | "default";
          }>;
          totalGap: number;
        }>;
        priorities: Array<{ branchId: number; branchName: string; slot: Slot; gap: number; waiting: number }>;
        totals: {
          branchCount: number;
          capacity: number;
          confirmedHeadcount: number;
          confirmedCoverage: number;
          waitingHeadcount: number;
          shortageSlots: number;
          totalGap: number;
          defaultCapacityCells: number;
        };
      };
};

const slots = ["평일오전", "평일오후", "주말오전", "주말오후"] as const;
const defaultCapacity = { 평일오전: 3, 평일오후: 4, 주말오전: 3, 주말오후: 4 };

async function loadModule(): Promise<OverviewModule> {
  try {
    return await import(new URL("./slot-board-overview.ts", import.meta.url).href) as OverviewModule;
  } catch {
    return {};
  }
}

test("slot-board navigation links do not enter the Button Radix Slot", async () => {
  const componentUrl = new URL("../../components/SlotBoard.tsx", import.meta.url);
  const sourceText = await readFile(componentUrl, "utf8");
  const sourceFile = ts.createSourceFile(
    componentUrl.pathname,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const foundTargets = new Set<"settings" | "priority">();
  const slottedTargets = new Set<"settings" | "priority">();

  const hasAttribute = (node: ts.JsxOpeningLikeElement, name: string) =>
    node.attributes.properties.some((attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === name
    );
  const targetFor = (node: ts.JsxElement): "settings" | "priority" | null => {
    const tagName = node.openingElement.tagName.getText(sourceFile);
    const href = node.openingElement.attributes.properties.find((attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === "href"
    );
    if (!href || !ts.isJsxAttribute(href)) return null;
    const hrefText = href.initializer?.getText(sourceFile) ?? "";
    if (tagName === "Link" && hrefText === '"/settings?section=branches"') return "settings";
    if (tagName === "a" && hrefText.includes("#slot-branch-")) return "priority";
    return null;
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const target = targetFor(node);
      if (target) {
        foundTargets.add(target);
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isSourceFile(parent)) {
          if (
            ts.isJsxElement(parent)
            && parent.openingElement.tagName.getText(sourceFile) === "Button"
            && hasAttribute(parent.openingElement, "asChild")
          ) {
            slottedTargets.add(target);
            break;
          }
          parent = parent.parent;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  assert.deepEqual([...foundTargets].sort(), ["priority", "settings"]);
  assert.deepEqual(
    [...slottedTargets],
    [],
    "Button adds a loading child before its asChild content, so these links would crash Radix Slot",
  );
});

test("totals stay unknown until all three slot-board sources have loaded", async () => {
  const { buildSlotBoardOverview } = await loadModule();

  assert.equal(typeof buildSlotBoardOverview, "function");
  assert.deepEqual(buildSlotBoardOverview!({
    branches: [],
    clients: [],
    slots,
    defaultCapacity,
  }), { state: "loading" });
});

test("failed sources are reported instead of being rendered as zero", async () => {
  const { buildSlotBoardOverview } = await loadModule();

  assert.equal(typeof buildSlotBoardOverview, "function");
  assert.deepEqual(buildSlotBoardOverview!({
    branches: [],
    clients: [],
    applicants: [],
    slots,
    defaultCapacity,
    errors: { branches: new Error("offline"), applicants: new Error("timeout") },
  }), { state: "error", sources: ["branches", "applicants"] });
});

test("only active branches of active slot-enabled clients appear", async () => {
  const { buildSlotBoardOverview } = await loadModule();

  assert.equal(typeof buildSlotBoardOverview, "function");
  const result = buildSlotBoardOverview!({
    branches: [
      { id: 1, name: "강남", active: true, client_id: 10, slot_capacity: {} },
      { id: 2, name: "강북", active: false, client_id: 10, slot_capacity: {} },
      { id: 3, name: "마포", active: true, client_id: 20, slot_capacity: {} },
      { id: 4, name: "성수", active: true, client_id: 30, slot_capacity: {} },
    ],
    clients: [
      { id: 10, name: "활성 슬롯사", uses_slots: true, active: true },
      { id: 20, name: "일반 화주사", uses_slots: false, active: true },
      { id: 30, name: "비활성 슬롯사", uses_slots: true, active: false },
    ],
    applicants: [],
    slots,
    defaultCapacity,
  });

  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  assert.deepEqual(result.rows.map((row) => row.branch.name), ["강남"]);
  assert.equal(result.totals.branchCount, 1);
});

test("explicit confirmed branch and slot take precedence over earlier preferences", async () => {
  const { buildSlotBoardOverview } = await loadModule();

  assert.equal(typeof buildSlotBoardOverview, "function");
  const result = buildSlotBoardOverview!({
    branches: [
      { id: 1, name: "서울", active: true, client_id: 10, slot_capacity: {} },
      { id: 2, name: "부산", active: true, client_id: 10, slot_capacity: {} },
    ],
    clients: [{ id: 10, name: "슬롯사", uses_slots: true, active: true }],
    applicants: [{
      id: 101,
      status: "확정인력",
      branch: "서울",
      branch1: "서울",
      confirmed_branch: "부산",
      work_hours: "주말 오후",
      confirmed_slot: "평일오전",
    }],
    slots,
    defaultCapacity,
  });

  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  const seoul = result.rows.find((row) => row.branch.name === "서울")!;
  const busan = result.rows.find((row) => row.branch.name === "부산")!;
  assert.equal(seoul.cells.find((cell) => cell.slot === "평일오전")!.confirmed, 0);
  assert.equal(busan.cells.find((cell) => cell.slot === "평일오전")!.confirmed, 1);
  assert.equal(busan.cells.find((cell) => cell.slot === "주말오후")!.confirmed, 0);
  assert.equal(result.totals.confirmedHeadcount, 1);
});

test("waiting means a waiting-status person matching the effective branch and preferred time", async () => {
  const { buildSlotBoardOverview } = await loadModule();

  assert.equal(typeof buildSlotBoardOverview, "function");
  const result = buildSlotBoardOverview!({
    branches: [
      { id: 1, name: "서울", active: true, client_id: 10, slot_capacity: { 평일오전: 2 } },
      { id: 2, name: "부산", active: true, client_id: 10, slot_capacity: { 평일오전: 2 } },
    ],
    clients: [{ id: 10, name: "슬롯사", uses_slots: true, active: true }],
    applicants: [
      { id: 201, status: "대기자", branch1: "부산", confirmed_branch: "서울", work_hours: "평일 오전" },
      { id: 202, status: "스크리닝 완료", branch1: "서울", work_hours: "평일 오전" },
    ],
    slots,
    defaultCapacity,
  });

  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  const seoulMorning = result.rows.find((row) => row.branch.name === "서울")!.cells[0];
  const busanMorning = result.rows.find((row) => row.branch.name === "부산")!.cells[0];
  assert.equal(seoulMorning.waiting, 1);
  assert.equal(busanMorning.waiting, 0);
  assert.equal(result.totals.waitingHeadcount, 1);
});

test("configured zero capacity is preserved while missing capacity uses the documented default", async () => {
  const { buildSlotBoardOverview } = await loadModule();

  assert.equal(typeof buildSlotBoardOverview, "function");
  const result = buildSlotBoardOverview!({
    branches: [{ id: 1, name: "서울", active: true, client_id: 10, slot_capacity: { 평일오전: 0 } }],
    clients: [{ id: 10, name: "슬롯사", uses_slots: true, active: true }],
    applicants: [],
    slots,
    defaultCapacity,
  });

  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  assert.deepEqual(result.rows[0].cells.map((cell) => [cell.slot, cell.capacity, cell.capacitySource]), [
    ["평일오전", 0, "configured"],
    ["평일오후", 4, "default"],
    ["주말오전", 3, "default"],
    ["주말오후", 4, "default"],
  ]);
  assert.equal(result.totals.capacity, 11);
  assert.equal(result.totals.defaultCapacityCells, 3);
});

test("shortage priorities sort the largest staffing gap first", async () => {
  const { buildSlotBoardOverview } = await loadModule();

  assert.equal(typeof buildSlotBoardOverview, "function");
  const result = buildSlotBoardOverview!({
    branches: [
      { id: 1, name: "강남", active: true, client_id: 10, slot_capacity: { 평일오전: 3, 평일오후: 1, 주말오전: 0, 주말오후: 0 } },
      { id: 2, name: "마포", active: true, client_id: 10, slot_capacity: { 평일오전: 4, 평일오후: 0, 주말오전: 0, 주말오후: 0 } },
    ],
    clients: [{ id: 10, name: "슬롯사", uses_slots: true, active: true }],
    applicants: [{ id: 301, status: "대기자", confirmed_branch: "강남", work_hours: "평일 오전" }],
    slots,
    defaultCapacity,
  });

  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  assert.deepEqual(result.priorities.map((item) => [item.branchName, item.slot, item.gap, item.waiting]), [
    ["마포", "평일오전", 4, 0],
    ["강남", "평일오전", 3, 1],
    ["강남", "평일오후", 1, 0],
  ]);
  assert.deepEqual({
    shortageSlots: result.totals.shortageSlots,
    totalGap: result.totals.totalGap,
  }, { shortageSlots: 3, totalGap: 8 });
  assert.deepEqual(result.rows.map((row) => [row.branch.name, row.totalGap]), [["마포", 4], ["강남", 4]]);
});
