import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConsultationJob, ConsultationSourceMessage } from "./consultation-types.ts";
import type { ConversationTurn } from "./types.ts";
import { CONVERSATIONAL_SENT_BY, matchJobsByText } from "./inbound-routing.ts";

const HISTORY_LIMIT = 50;
const CONVERSATION_SENDERS = new Set<string>([...CONVERSATIONAL_SENT_BY, "agent-practice"]);
const ADVERTISEMENT_PREFIX = /^\s*(?:\[(?:Web발신|국제발신)\]\s*)?(?:\[광고\]|\(광고\))/i;

interface MessageRow extends ConsultationSourceMessage {
  direction: ConversationTurn["direction"];
  sent_by: string | null;
  job_id: number | null;
}

/** 공고를 가로지른 실제 상담 문맥과 아직 답하지 않은 수신 원문만 읽는다. */
export async function loadConsultationHistory(
  supabase: SupabaseClient,
  applicantId: number,
  current: ConsultationSourceMessage,
  jobs: ConsultationJob[],
): Promise<{ history: ConversationTurn[]; sourceMessages: ConsultationSourceMessage[]; ambiguousFollowup: boolean }> {
  if (!current.id || typeof current.body !== "string" || !Number.isFinite(Date.parse(current.created_at))) {
    throw new Error("상담 수신 원문이 유효하지 않습니다.");
  }
  const { data, error } = await supabase.from("messages")
    .select("id, direction, body, created_at, sent_by, job_id")
    .eq("applicant_id", applicantId).lte("created_at", current.created_at)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(HISTORY_LIMIT);
  if (error || !Array.isArray(data)) throw new Error(`상담 대화 조회 실패: ${error?.message ?? "invalid response"}`);

  const rows = (data as MessageRow[]).filter((row) => row.id !== current.id && (
    row.direction === "inbound" || (row.direction === "outbound"
      && CONVERSATION_SENDERS.has(row.sent_by ?? "") && !ADVERTISEMENT_PREFIX.test(row.body))
  )).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
  let lastOutboundIndex = -1;
  for (let index = rows.length - 1; index >= 0; index--) {
    if (rows[index].direction === "outbound") {
      lastOutboundIndex = index;
      break;
    }
  }
  // 상한 안에 답변 경계가 없으면 이전 미응답 문자가 잘렸는지 알 수 없다. 일부만 추출하지 않는다.
  if (data.length >= HISTORY_LIMIT && lastOutboundIndex === -1) {
    throw new Error("상담 대화 조회 상한에서 미응답 원문이 잘린 가능성이 있습니다.");
  }
  const lastOutbound = rows[lastOutboundIndex];
  const sourceMessages: ConsultationSourceMessage[] = rows.slice(lastOutboundIndex + 1)
    .filter((row) => row.direction === "inbound")
    .map(({ id, body, created_at }) => ({ id, body, created_at }));
  // 웹훅과 연습 경로 어느 쪽이든 현재 원문은 딱 한 번 포함한다. 접두어·공백도 인용 검증에 필요하다.
  sourceMessages.push({ id: current.id, body: current.body, created_at: current.created_at });
  return {
    history: rows.map(({ direction, body, created_at }) => ({ direction, body, created_at })),
    sourceMessages,
    ambiguousFollowup: Boolean(lastOutbound && (lastOutbound.job_id == null || matchJobsByText(lastOutbound.body, jobs).length > 1)),
  };
}
