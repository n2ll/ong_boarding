import assert from "node:assert/strict";
import test from "node:test";

type SosData = {
  open: unknown[];
  recent: unknown[];
  month_summary: { count: number; resolved: number; cost_sum: number };
};

type LedgerData = {
  month: string;
  rows: unknown[];
  total: number;
};

type SourceView<T> =
  | { state: "loading" | "error" }
  | { state: "ready" | "stale"; data: T };

type SosLedgerCardViewModule = {
  sosLedgerCardView?: (input: {
    sosData?: SosData;
    sosError?: unknown;
    ledgerData?: LedgerData;
    ledgerError?: unknown;
  }) => { sos: SourceView<SosData>; ledger: SourceView<LedgerData> };
};

async function loadModule(): Promise<SosLedgerCardViewModule> {
  try {
    return await import(new URL("./sos-ledger-card-view.ts", import.meta.url).href) as SosLedgerCardViewModule;
  } catch {
    return {};
  }
}

const sosZero: SosData = {
  open: [],
  recent: [],
  month_summary: { count: 0, resolved: 0, cost_sum: 0 },
};

const ledgerZero: LedgerData = {
  month: "2026-08",
  rows: [],
  total: 0,
};

test("missing SOS and ledger responses stay loading instead of becoming zero", async () => {
  const { sosLedgerCardView } = await loadModule();

  assert.equal(typeof sosLedgerCardView, "function");
  assert.deepEqual(sosLedgerCardView!({}), {
    sos: { state: "loading" },
    ledger: { state: "loading" },
  });
});

test("an SOS failure never becomes an empty emergency queue", async () => {
  const { sosLedgerCardView } = await loadModule();

  assert.equal(typeof sosLedgerCardView, "function");
  assert.deepEqual(sosLedgerCardView!({
    sosError: new Error("offline"),
    ledgerData: ledgerZero,
  }), {
    sos: { state: "error" },
    ledger: { state: "ready", data: ledgerZero },
  });
});

test("SOS and ledger failures remain independent", async () => {
  const { sosLedgerCardView } = await loadModule();

  assert.equal(typeof sosLedgerCardView, "function");
  assert.deepEqual(sosLedgerCardView!({
    sosData: sosZero,
    ledgerError: new Error("ledger offline"),
  }), {
    sos: { state: "ready", data: sosZero },
    ledger: { state: "error" },
  });
});

test("cached data with a refresh error is marked stale and remains visible", async () => {
  const { sosLedgerCardView } = await loadModule();

  assert.equal(typeof sosLedgerCardView, "function");
  assert.deepEqual(sosLedgerCardView!({
    sosData: sosZero,
    sosError: new Error("refresh failed"),
    ledgerData: ledgerZero,
    ledgerError: new Error("refresh failed"),
  }), {
    sos: { state: "stale", data: sosZero },
    ledger: { state: "stale", data: ledgerZero },
  });
});

test("only complete successful responses may present explicit zero values", async () => {
  const { sosLedgerCardView } = await loadModule();

  assert.equal(typeof sosLedgerCardView, "function");
  assert.deepEqual(sosLedgerCardView!({ sosData: sosZero, ledgerData: ledgerZero }), {
    sos: { state: "ready", data: sosZero },
    ledger: { state: "ready", data: ledgerZero },
  });
  assert.deepEqual(sosLedgerCardView!({
    sosData: {} as SosData,
    ledgerData: {} as LedgerData,
  }), {
    sos: { state: "error" },
    ledger: { state: "error" },
  });
});

test("malformed rows never reach the renderer as ready data", async () => {
  const { sosLedgerCardView } = await loadModule();

  assert.equal(typeof sosLedgerCardView, "function");
  assert.deepEqual(sosLedgerCardView!({
    sosData: { ...sosZero, open: [null] },
    ledgerData: { ...ledgerZero, rows: [null] },
  }), {
    sos: { state: "error" },
    ledger: { state: "error" },
  });
});

test("invalid month and negative aggregates never masquerade as valid zero states", async () => {
  const { sosLedgerCardView } = await loadModule();

  assert.equal(typeof sosLedgerCardView, "function");
  assert.deepEqual(sosLedgerCardView!({
    sosData: {
      ...sosZero,
      month_summary: { count: -1, resolved: 0, cost_sum: 0 },
    },
    ledgerData: { ...ledgerZero, month: "2026-13", total: -1 },
  }), {
    sos: { state: "error" },
    ledger: { state: "error" },
  });
});
