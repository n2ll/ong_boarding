export type SlotBoardSource = "branches" | "clients" | "applicants";

export type SlotBoardBranch = {
  id: number;
  name: string;
  active: boolean;
  client_id: number | null;
  slot_capacity: Record<string, number> | null;
};

export type SlotBoardClient = {
  id: number;
  name: string;
  uses_slots: boolean;
  active?: boolean;
};

export type SlotBoardApplicant = {
  id: number;
  status: string;
  branch?: string | null;
  branch1?: string | null;
  confirmed_branch?: string | null;
  work_hours?: string | null;
  confirmed_slot?: string | null;
};

export type SlotBoardCell<TSlot extends string> = {
  slot: TSlot;
  capacity: number;
  confirmed: number;
  waiting: number;
  gap: number;
  capacitySource: "configured" | "default";
};

export type SlotBoardOverview<TSlot extends string> =
  | { state: "loading" }
  | { state: "error"; sources: SlotBoardSource[] }
  | {
      state: "ready";
      rows: Array<{
        branch: Pick<SlotBoardBranch, "id" | "name">;
        client: Pick<SlotBoardClient, "id" | "name">;
        cells: Array<SlotBoardCell<TSlot>>;
        totalGap: number;
      }>;
      priorities: Array<{
        branchId: number;
        branchName: string;
        slot: TSlot;
        gap: number;
        waiting: number;
      }>;
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

function tokens(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "" && token !== "미지정");
}

function effectiveBranches(applicant: SlotBoardApplicant): string[] {
  const confirmed = tokens(applicant.confirmed_branch);
  if (confirmed.length > 0) return confirmed;
  const preferred = tokens(applicant.branch1);
  if (preferred.length > 0) return preferred;
  return tokens(applicant.branch);
}

function matchesSlot(value: string | null | undefined, slot: string): boolean {
  const day = slot.includes("평일") ? "평일" : slot.includes("주말") ? "주말" : "";
  const time = slot.includes("오전") ? "오전" : slot.includes("오후") ? "오후" : "";
  if (!day || !time) return false;
  return tokens(value).some((token) => token.includes(day) && token.includes(time));
}

export function buildSlotBoardOverview<TSlot extends string>(input: {
  branches?: SlotBoardBranch[];
  clients?: SlotBoardClient[];
  applicants?: SlotBoardApplicant[];
  slots: readonly TSlot[];
  defaultCapacity: Record<TSlot, number>;
  clientId?: number | null;
  errors?: Partial<Record<SlotBoardSource, unknown>>;
}): SlotBoardOverview<TSlot> {
  const sourceOrder: SlotBoardSource[] = ["branches", "clients", "applicants"];
  const failedSources = sourceOrder.filter((source) => Boolean(input.errors?.[source]));
  if (failedSources.length > 0) return { state: "error", sources: failedSources };
  if (sourceOrder.some((source) => input[source] === undefined)) return { state: "loading" };

  const clientsById = new Map(
    input.clients!
      .filter((client) => client.uses_slots && client.active !== false)
      .map((client) => [client.id, client]),
  );
  const rows = input.branches!
    .filter((branch) => branch.active)
    .filter((branch) => branch.client_id !== null && clientsById.has(branch.client_id))
    .filter((branch) => input.clientId == null || branch.client_id === input.clientId)
    .map((branch) => {
      const client = clientsById.get(branch.client_id!)!;
      return {
        branch: { id: branch.id, name: branch.name },
        client: { id: client.id, name: client.name },
        cells: input.slots.map((slot) => {
          const raw = branch.slot_capacity?.[slot];
          const configured = typeof raw === "number" && Number.isFinite(raw);
          return {
            slot,
            capacity: configured ? Math.max(0, raw) : Math.max(0, input.defaultCapacity[slot]),
            confirmed: 0,
            waiting: 0,
            gap: 0,
            capacitySource: configured ? "configured" as const : "default" as const,
          };
        }),
        totalGap: 0,
      };
    });

  const rowsByName = new Map(rows.map((row) => [row.branch.name.trim(), row]));
  const confirmedIds = new Set<number>();
  const waitingIds = new Set<number>();

  for (const applicant of input.applicants!) {
    const isConfirmed = applicant.status === "확정인력";
    const isWaiting = applicant.status === "대기자";
    if (!isConfirmed && !isWaiting) continue;

    const slotValue = isConfirmed
      ? tokens(applicant.confirmed_slot).length > 0
        ? applicant.confirmed_slot
        : applicant.work_hours
      : applicant.work_hours;
    let matched = false;

    for (const branchName of effectiveBranches(applicant)) {
      const row = rowsByName.get(branchName);
      if (!row) continue;
      for (const cell of row.cells) {
        if (!matchesSlot(slotValue, cell.slot)) continue;
        if (isConfirmed) cell.confirmed += 1;
        else cell.waiting += 1;
        matched = true;
      }
    }

    if (matched) {
      if (isConfirmed) confirmedIds.add(applicant.id);
      else waitingIds.add(applicant.id);
    }
  }

  for (const row of rows) {
    for (const cell of row.cells) cell.gap = Math.max(0, cell.capacity - cell.confirmed);
    row.totalGap = row.cells.reduce((sum, cell) => sum + cell.gap, 0);
  }
  rows.sort((a, b) => {
    const gapOrder = b.totalGap - a.totalGap;
    if (gapOrder !== 0) return gapOrder;
    const aMax = Math.max(...a.cells.map((cell) => cell.gap));
    const bMax = Math.max(...b.cells.map((cell) => cell.gap));
    return bMax - aMax || a.branch.name.localeCompare(b.branch.name, "ko");
  });

  const allCells = rows.flatMap((row) => row.cells.map((cell) => ({ row, cell })));
  const priorities = allCells
    .filter(({ cell }) => cell.gap > 0)
    .map(({ row, cell }) => ({
      branchId: row.branch.id,
      branchName: row.branch.name,
      slot: cell.slot,
      gap: cell.gap,
      waiting: cell.waiting,
    }))
    .sort((a, b) => b.gap - a.gap || b.waiting - a.waiting || a.branchName.localeCompare(b.branchName, "ko"));

  return {
    state: "ready",
    rows,
    priorities,
    totals: {
      branchCount: rows.length,
      capacity: allCells.reduce((sum, { cell }) => sum + cell.capacity, 0),
      confirmedHeadcount: confirmedIds.size,
      confirmedCoverage: allCells.reduce((sum, { cell }) => sum + cell.confirmed, 0),
      waitingHeadcount: waitingIds.size,
      shortageSlots: priorities.length,
      totalGap: priorities.reduce((sum, item) => sum + item.gap, 0),
      defaultCapacityCells: allCells.filter(({ cell }) => cell.capacitySource === "default").length,
    },
  };
}
