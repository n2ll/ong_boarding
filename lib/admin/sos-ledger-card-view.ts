import type { CostCategory, SosResolution } from "@/lib/sos";

export interface SosLedgerSosRow {
  id: number;
  created_at: string;
  line_label: string;
  region: string | null;
  vehicle: string | null;
  needed_count: number;
  note: string | null;
  status: "open" | "resolved" | "cancelled";
  resolved_at: string | null;
  resolution: SosResolution | null;
  cost_krw: number | null;
  duration_minutes: number | null;
  resolution_note: string | null;
}

export interface SosLedgerSosData {
  open: SosLedgerSosRow[];
  recent: SosLedgerSosRow[];
  month_summary: { count: number; resolved: number; cost_sum: number };
}

export interface SosLedgerCostRow {
  id: number;
  month: string;
  category: CostCategory | string;
  amount_krw: number;
  memo: string | null;
}

export interface SosLedgerCostData {
  month: string;
  rows: SosLedgerCostRow[];
  total: number;
}

export type SosLedgerSourceView<T> =
  | { state: "loading" | "error" }
  | { state: "ready" | "stale"; data: T };

export type SosLedgerCardView = {
  sos: SosLedgerSourceView<SosLedgerSosData>;
  ledger: SosLedgerSourceView<SosLedgerCostData>;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;

const isNullableString = (value: unknown): value is string | null =>
  typeof value === "string" || value === null;

function isSosRow(value: unknown): value is SosLedgerSosRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SosLedgerSosRow>;
  return isNonNegativeInteger(row.id)
    && typeof row.created_at === "string"
    && typeof row.line_label === "string"
    && isNullableString(row.region)
    && isNullableString(row.vehicle)
    && isNonNegativeInteger(row.needed_count)
    && isNullableString(row.note)
    && (row.status === "open" || row.status === "resolved" || row.status === "cancelled")
    && isNullableString(row.resolved_at)
    && (typeof row.resolution === "string" || row.resolution === null)
    && (isNonNegativeInteger(row.cost_krw) || row.cost_krw === null)
    && (isNonNegativeInteger(row.duration_minutes) || row.duration_minutes === null)
    && isNullableString(row.resolution_note);
}

function isLedgerRow(value: unknown): value is SosLedgerCostRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SosLedgerCostRow>;
  return isNonNegativeInteger(row.id)
    && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.month ?? "")
    && typeof row.category === "string"
    && isNonNegativeInteger(row.amount_krw)
    && isNullableString(row.memo);
}

function isSosData(value: unknown): value is SosLedgerSosData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<SosLedgerSosData>;
  const summary = data.month_summary;
  return Array.isArray(data.open)
    && data.open.every(isSosRow)
    && Array.isArray(data.recent)
    && data.recent.every(isSosRow)
    && Boolean(summary)
    && isNonNegativeInteger(summary?.count)
    && isNonNegativeInteger(summary?.resolved)
    && isNonNegativeInteger(summary?.cost_sum);
}

function isLedgerData(value: unknown): value is SosLedgerCostData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<SosLedgerCostData>;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(data.month ?? "")
    && Array.isArray(data.rows)
    && data.rows.every(isLedgerRow)
    && isNonNegativeInteger(data.total);
}

function sourceView<T>(
  data: unknown,
  error: unknown,
  isValid: (value: unknown) => value is T,
): SosLedgerSourceView<T> {
  if (isValid(data)) return { state: error ? "stale" : "ready", data };
  if (data === undefined && !error) return { state: "loading" };
  return { state: "error" };
}

export function sosLedgerCardView(input: {
  sosData?: unknown;
  sosError?: unknown;
  ledgerData?: unknown;
  ledgerError?: unknown;
}): SosLedgerCardView {
  return {
    sos: sourceView(input.sosData, input.sosError, isSosData),
    ledger: sourceView(input.ledgerData, input.ledgerError, isLedgerData),
  };
}
