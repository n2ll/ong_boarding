/** The same applicant row serializes a reply and a public conversation switch.
 * A crashed/uncertain turn retains its claim until an operator checks provider logs.
 */
export async function withConversationReplyClaim<T>(args: {
  applicantId: number;
  jobId: number;
  receivedAt?: string;
  inboundMessageId?: string;
  retainClaim?: (result: T) => boolean;
  rpc: (name: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  run: () => Promise<T>;
}): Promise<{ executed: true; result: T } | { executed: false; reason: string }> {
  const claimKey = crypto.randomUUID();
  const claim = await args.rpc("claim_pool_agent_reply", {
    p_applicant_id: args.applicantId, p_job_id: args.jobId, p_claim_key: claimKey, p_received_at: args.receivedAt ?? null,
    p_inbound_message_id: args.inboundMessageId ?? null,
  });
  if (claim.error || claim.data !== "claimed") {
    return { executed: false, reason: claim.error ? "claim_unavailable" : String(claim.data) };
  }
  // Do not release on an unhandled exception: an SMS may have reached the provider.
  const result = await args.run();
  if (args.retainClaim?.(result)) return { executed: true, result };
  const release = await args.rpc("release_pool_agent_reply", {
    p_applicant_id: args.applicantId, p_claim_key: claimKey, p_inbound_message_id: args.inboundMessageId ?? null,
  });
  if (release.error || release.data !== "released") {
    console.error("[agent] reply claim release failed; operator review required", { applicantId: args.applicantId });
  }
  return { executed: true, result };
}
