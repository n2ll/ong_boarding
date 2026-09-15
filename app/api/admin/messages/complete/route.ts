import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { REPLY_COMPLETED_EVENT, isReplyMessageId, type ReplyMessageId } from "@/lib/admin/reply-completion";
import { loadReplyCompletionStatus } from "@/lib/admin/reply-completion-status";

export const dynamic = "force-dynamic";

function completionActionKey(applicantId: number, messageId: ReplyMessageId): string {
  const bytes = createHash("sha256").update(JSON.stringify([REPLY_COMPLETED_EVENT, applicantId, messageId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 매니저가 확인한 마지막 수신만 완료한다. 새 문자·다른 공고 인계·초안은 완료하지 않는다. */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const value: unknown = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid body");
    body = value as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "요청 형식을 확인해 주세요." }, { status: 400 });
  }
  const { applicant_id: applicantId, message_id: messageId, outcome } = body;
  if (typeof applicantId !== "number" || !Number.isSafeInteger(applicantId) || applicantId <= 0
    || !isReplyMessageId(messageId)
    || (outcome !== "call" && outcome !== "no_reply")
    || (body.note !== undefined && typeof body.note !== "string")) {
    return NextResponse.json({ error: "지원자와 문자, 처리 결과를 확인해 주세요." }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
  const db = createServiceClient();
  try {
    const latest = await db.from("messages")
      .select("id, direction")
      .eq("applicant_id", applicantId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1).maybeSingle();
    if (latest.error) throw latest.error;
    if (latest.data?.id !== messageId || latest.data?.direction !== "inbound") {
      return NextResponse.json({ error: "새 문자나 처리 기록이 있어요. 최신 대화를 확인해 주세요." }, { status: 409 });
    }
    const [drafts, status] = await Promise.all([
      db.from("message_drafts").select("id").eq("applicant_id", applicantId)
        .in("status", ["pending", "need_info"]).limit(1),
      loadReplyCompletionStatus(db, [{ applicant_id: applicantId, message_id: messageId }]),
    ]);
    if (drafts.error || !Array.isArray(drafts.data)) throw drafts.error ?? new Error("invalid drafts");
    if (drafts.data.length > 0 || status.handoffRequired.has(applicantId)) {
      return NextResponse.json({ error: "검토할 초안이나 사람 확인이 필요한 인계가 남아 있어요. 해당 업무를 먼저 처리해 주세요." }, { status: 409 });
    }
    const actionKey = completionActionKey(applicantId, messageId);
    const meta = { message_id: messageId, outcome, ...(note ? { note } : {}) };
    // 기존 partial unique action_key를 사용한다. 최신 문자 확인 뒤 새 수신이 와도 이 ID만 완료된다.
    const saved = await db.from("pool_events").insert({
      applicant_id: applicantId, job_id: null, event_type: REPLY_COMPLETED_EVENT, action_key: actionKey, meta,
    });
    if (saved.error?.code === "23505") {
      const existing = await db.from("pool_events").select("applicant_id, event_type, meta")
        .eq("action_key", actionKey).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data?.applicant_id !== applicantId || existing.data?.event_type !== REPLY_COMPLETED_EVENT
        || existing.data?.meta?.message_id !== messageId || existing.data?.meta?.outcome !== outcome
        || (existing.data?.meta?.note ?? "") !== note) {
        return NextResponse.json({ error: "이미 다른 처리 결과가 기록됐어요. 대화를 다시 확인해 주세요." }, { status: 409 });
      }
    } else if (saved.error) throw saved.error;
    return NextResponse.json({ success: true, message_id: messageId });
  } catch (error) {
    console.error("[messages/complete]", error);
    return NextResponse.json({ error: "처리 상태를 확인하거나 저장하지 못했어요. 다시 시도해 주세요." }, { status: 503 });
  }
}
