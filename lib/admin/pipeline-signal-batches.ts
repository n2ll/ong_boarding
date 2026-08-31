import { requestWithTimeout } from "../request-timeout.ts";

const SIGNAL_BATCH_SIZE = 500;
const SIGNAL_REQUEST_TIMEOUT_MS = 15_000;

export interface PipelineActiveCheck {
  configured: boolean;
  checked: number;
  active: Array<{ id: number; name: string; reasons: string[] }>;
  unchecked?: number;
}

export interface PipelinePoolEventSummary {
  last_ping_at: string | null;
  last_link_view_at: string | null;
  last_interest: { job_id: number | null; at: string; immediate: boolean } | null;
  last_reply_at: string | null;
}

type FetchResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponse>;

export type PipelineSignalLookupState = "idle" | "loading" | "ready" | "error";

export function pipelineApplicantActionsBlocked(
  state: "loading" | "error" | "empty" | "ready",
): boolean {
  return state === "loading" || state === "error";
}

export function pipelineNeedsSummary(input: {
  view: "list" | "kanban" | "map" | "funnel";
  excludeRecentPing: boolean;
  reactionOnly: boolean;
  sortMode: string;
}): boolean {
  if (input.view === "funnel") return false;
  return (
    input.view === "list" ||
    input.excludeRecentPing ||
    input.reactionOnly ||
    input.sortMode === "reaction_recent"
  );
}

export function pipelineSignalsBlockResults(input: {
  excludeActive: boolean;
  summaryDependent: boolean;
  activeComplete: boolean;
  summaryComplete: boolean;
}): boolean {
  return (
    (input.excludeActive && !input.activeComplete) ||
    (input.summaryDependent && !input.summaryComplete)
  );
}

export function pipelineSummaryRowStatus(input: {
  state: PipelineSignalLookupState;
  currentKey: string | null;
  expectedKey: string;
}): "checking" | "ready" | "error" {
  if (input.state === "error") return "error";
  if (input.state === "ready" && input.currentKey === input.expectedKey) return "ready";
  return "checking";
}

export function pipelineShowsNormalEmptyState(input: {
  applicantsState: "loading" | "error" | "empty" | "ready";
  resultCount: number;
  signalsBlocked: boolean;
}): boolean {
  return (
    !input.signalsBlocked &&
    (input.applicantsState === "empty" || input.applicantsState === "ready") &&
    input.resultCount === 0
  );
}

export function pipelineActiveCheckBlocksSend(input: {
  modalOpen: boolean;
  selectedIds: string[];
  state: PipelineSignalLookupState;
  coveredIds: Set<string>;
}): boolean {
  return input.modalOpen && input.selectedIds.length > 0 && (
    input.state !== "ready" || input.selectedIds.some((id) => !input.coveredIds.has(id))
  );
}

function uniqueNumericIds(ids: Array<string | number>): number[] {
  return [...new Set(ids.map(Number).filter(Number.isFinite))];
}

function toBatches(ids: Array<string | number>): number[][] {
  const normalized = uniqueNumericIds(ids);
  const batches: number[][] = [];
  for (let index = 0; index < normalized.length; index += SIGNAL_BATCH_SIZE) {
    batches.push(normalized.slice(index, index + SIGNAL_BATCH_SIZE));
  }
  return batches;
}

async function postBatch(
  endpoint: string,
  applicantIds: number[],
  label: string,
  fetcher: FetchLike,
  timeoutMs: number,
): Promise<unknown> {
  return requestWithTimeout(async (signal) => {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicantIds }),
      signal,
    });
    const json = await response.json().catch(() => null) as { error?: unknown } | null;
    if (!response.ok) {
      const detail = typeof json?.error === "string" ? `: ${json.error}` : "";
      throw new Error(`${label} 조회 실패${detail}`);
    }
    return json;
  }, timeoutMs);
}

/** 모든 배치가 성공한 뒤에만 병합 결과를 반환해 부분 활동 판정을 정상값으로 노출하지 않는다. */
export async function fetchActiveSignalBatches(
  ids: Array<string | number>,
  fetcher: FetchLike = fetch,
  timeoutMs = SIGNAL_REQUEST_TIMEOUT_MS,
): Promise<PipelineActiveCheck> {
  const batches = toBatches(ids);
  if (batches.length === 0) {
    return { configured: false, checked: 0, active: [], unchecked: 0 };
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const json = await postBatch(
        "/api/admin/ongmanaging/active-check",
        batch,
        "활동 여부",
        fetcher,
        timeoutMs,
      ) as Partial<PipelineActiveCheck> | null;
      if (
        !json ||
        typeof json.configured !== "boolean" ||
        typeof json.checked !== "number" ||
        !Array.isArray(json.active)
      ) {
        throw new Error("활동 여부 조회 응답 형식이 올바르지 않습니다.");
      }
      return json as PipelineActiveCheck;
    }),
  );

  const activeById = new Map<number, PipelineActiveCheck["active"][number]>();
  for (const result of results) {
    for (const row of result.active) {
      const existing = activeById.get(row.id);
      activeById.set(row.id, existing
        ? { ...existing, reasons: [...new Set([...existing.reasons, ...row.reasons])] }
        : row);
    }
  }

  return {
    configured: results.some((result) => result.configured),
    checked: results.reduce((sum, result) => sum + result.checked, 0),
    active: [...activeById.values()],
    unchecked: results.reduce((sum, result) => sum + (result.unchecked ?? 0), 0),
  };
}

/** 모든 배치가 성공한 뒤에만 병합 결과를 반환해 부분 반응 이력을 정상값으로 노출하지 않는다. */
export async function fetchSummarySignalBatches(
  ids: Array<string | number>,
  fetcher: FetchLike = fetch,
  timeoutMs = SIGNAL_REQUEST_TIMEOUT_MS,
): Promise<Record<number, PipelinePoolEventSummary>> {
  const batches = toBatches(ids);
  if (batches.length === 0) return {};

  const results = await Promise.all(
    batches.map(async (batch) => {
      const json = await postBatch(
        "/api/admin/pool-events/summary",
        batch,
        "반응 이력",
        fetcher,
        timeoutMs,
      ) as { summaryById?: unknown } | null;
      if (!json || typeof json.summaryById !== "object" || json.summaryById === null) {
        throw new Error("반응 이력 조회 응답 형식이 올바르지 않습니다.");
      }
      return json.summaryById as Record<number, PipelinePoolEventSummary>;
    }),
  );

  return Object.assign({}, ...results);
}
