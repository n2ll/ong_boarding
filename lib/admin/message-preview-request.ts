export const MESSAGE_PREVIEW_IDS_PER_REQUEST = 250;
const MAX_PARALLEL_PREVIEW_REQUESTS = 3;

type PreviewFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface MessagePreviewResponse {
  body: string;
  direction: "inbound" | "outbound";
  created_at: string;
  last_inbound_at?: string | null;
}

export type MessagePreviewResponseMap = Record<number, MessagePreviewResponse>;

export type PreviewRequestIdResult =
  | { ok: true; ids: number[] }
  | { ok: false; status: 400 | 413 };

function isApplicantId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function uniqueApplicantIds(ids: number[]): number[] {
  if (!ids.every(isApplicantId)) throw new Error("invalid preview applicant ids");
  return Array.from(new Set(ids));
}

export function parsePreviewRequestIds(value: unknown): PreviewRequestIdResult {
  if (!Array.isArray(value)) {
    return { ok: false, status: 400 };
  }
  if (value.length > MESSAGE_PREVIEW_IDS_PER_REQUEST) {
    return { ok: false, status: 413 };
  }
  if (!value.every(isApplicantId)) {
    return { ok: false, status: 400 };
  }
  return { ok: true, ids: Array.from(new Set(value)) };
}

function previewIdBatches(ids: number[]): number[][] {
  const batches: number[][] = [];
  for (let index = 0; index < ids.length; index += MESSAGE_PREVIEW_IDS_PER_REQUEST) {
    batches.push(ids.slice(index, index + MESSAGE_PREVIEW_IDS_PER_REQUEST));
  }
  return batches;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPreview(value: unknown): value is MessagePreviewResponse {
  return isObject(value)
    && typeof value.body === "string"
    && (value.direction === "inbound" || value.direction === "outbound")
    && typeof value.created_at === "string"
    && value.created_at.length > 0;
}

export async function fetchMessagePreviews(
  applicantIds: number[],
  options: { fetcher?: PreviewFetcher; signal?: AbortSignal } = {},
): Promise<MessagePreviewResponseMap> {
  const fetcher = options.fetcher ?? fetch;
  const batches = previewIdBatches(uniqueApplicantIds(applicantIds));
  const previews: MessagePreviewResponseMap = {};

  for (let index = 0; index < batches.length; index += MAX_PARALLEL_PREVIEW_REQUESTS) {
    const maps = await Promise.all(
      batches.slice(index, index + MAX_PARALLEL_PREVIEW_REQUESTS).map(async (ids) => {
        const response = await fetcher("/api/admin/messages/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
          signal: options.signal,
        });
        if (!response.ok) throw new Error(`preview ${response.status}`);

        const body: unknown = await response.json();
        if (!isObject(body) || !isObject(body.previews)) {
          throw new Error("invalid preview response");
        }
        const batchPreviews: MessagePreviewResponseMap = {};
        for (const id of ids) {
          const preview = body.previews[id];
          if (!isPreview(preview)) throw new Error("invalid preview response");
          batchPreviews[id] = preview;
        }
        return batchPreviews;
      }),
    );
    for (const map of maps) Object.assign(previews, map);
  }

  return previews;
}
