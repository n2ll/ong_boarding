import type { SupabaseClient } from "@supabase/supabase-js";

/** 기존 수신 원문만 재처리한다. 대화 잠금을 잡은 뒤에도 같은 검사를 반복한다. */
export async function loadPendingAgentReply(
  db: SupabaseClient,
  applicantId: number,
  expectedMessageId?: string,
  checkClaim = false,
): Promise<
  | { ok: true; message: { id: string; body: string; created_at: string } }
  | { ok: false; error: string }
> {
  const latest = await db.from("messages").select("id, body, created_at")
    .eq("applicant_id", applicantId).eq("direction", "inbound")
    .order("created_at", { ascending: false }).limit(1);
  if (latest.error) return { ok: false, error: "대기 문자를 확인하지 못했어요. 새로고침 후 확인해 주세요." };
  const message = latest.data?.[0];
  if (!message?.id || !message.body || !Number.isFinite(Date.parse(message.created_at))) {
    return { ok: false, error: "AI가 처리할 수신 문자가 없어요." };
  }
  if (expectedMessageId && message.id !== expectedMessageId) {
    return { ok: false, error: "새 문자가 도착했어요. 최신 대화를 확인해 주세요." };
  }
  const [person, outbound, drafts, pending, manualPending] = await Promise.all([
    db.from("applicants").select("id, status, sms_opt_out_at, agent_reply_claim_key")
      .eq("id", applicantId).maybeSingle(),
    db.from("messages").select("id").eq("applicant_id", applicantId).eq("direction", "outbound")
      .gte("created_at", message.created_at).limit(1),
    db.from("message_drafts").select("id").eq("inbound_message_id", message.id).limit(1),
    db.from("pool_engage_send_requests").select("status").eq("applicant_id", applicantId)
      .in("status", ["sending", "unknown", "sent"]).limit(1),
    db.from("manual_message_send_requests").select("status").eq("applicant_id", applicantId)
      .in("status", ["sending", "unknown", "sent"]).limit(1),
  ]);
  if ([person, outbound, drafts, pending, manualPending].some((r) => r.error) || !person.data) {
    return { ok: false, error: "기존 처리 상태를 확인하지 못해 응답을 보류했어요." };
  }
  if (person.data.sms_opt_out_at || ["인력풀 제외", "부적합", "이탈"].includes(person.data.status)) {
    return { ok: false, error: "수신 거부 또는 제외된 지원자에게는 AI 답장을 보낼 수 없어요." };
  }
  if ((checkClaim && person.data.agent_reply_claim_key) || pending.data?.length || manualPending.data?.length) {
    return { ok: false, error: "이미 처리 중이거나 발송 확인이 필요한 문자가 있어요." };
  }
  if (outbound.data?.length || drafts.data?.length) {
    return { ok: false, error: "이 문자에는 이미 답장 또는 처리 기록이 있어요. 중복 답장은 보내지 않았어요." };
  }
  return { ok: true, message };
}
