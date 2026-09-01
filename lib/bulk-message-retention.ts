interface BulkMessageRetentionRpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: { message?: string } | null;
  }>;
}

export interface BulkMessageRetentionCounts {
  expiredGuards: number;
  redactedRecipients: number;
  redactedBatches: number;
}

const DEFAULT_BATCH_LIMIT = 25;
const MAX_BATCH_LIMIT = 100;
const DEFAULT_RECIPIENT_LIMIT = 100;
const MAX_RECIPIENT_LIMIT = 500;

function nonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

/**
 * Terminal outbox rows retain only replay-safe tombstones after the retention window.
 * This runner intentionally has no provider or message-send dependency.
 */
export async function redactExpiredBulkMessageOutbox(
  supabase: BulkMessageRetentionRpcClient,
  options: { batchLimit?: number; recipientLimit?: number } = {},
): Promise<BulkMessageRetentionCounts> {
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const recipientLimit = options.recipientLimit ?? DEFAULT_RECIPIENT_LIMIT;
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_BATCH_LIMIT) {
    throw new RangeError(`bulk message retention batch limit must be between 1 and ${MAX_BATCH_LIMIT}`);
  }
  if (!Number.isInteger(recipientLimit) || recipientLimit < 1 || recipientLimit > MAX_RECIPIENT_LIMIT) {
    throw new RangeError(`bulk message retention recipient limit must be between 1 and ${MAX_RECIPIENT_LIMIT}`);
  }

  const { data, error } = await supabase.rpc("redact_bulk_message_terminal_data", {
    p_batch_limit: batchLimit,
    p_recipient_limit: recipientLimit,
  });
  if (error) {
    throw new Error(error.message || "bulk message retention failed");
  }

  const payload = data && typeof data === "object"
    ? data as Record<string, unknown>
    : null;
  const expiredGuards = nonNegativeInteger(payload?.expired_guards);
  const redactedRecipients = nonNegativeInteger(payload?.redacted_recipients);
  const redactedBatches = nonNegativeInteger(payload?.redacted_batches);

  if (expiredGuards === null || redactedRecipients === null || redactedBatches === null) {
    throw new Error("invalid bulk message retention result");
  }

  return { expiredGuards, redactedRecipients, redactedBatches };
}
