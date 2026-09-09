import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConsultationJob, ConsultationNumberedReference, ConsultationSourceMessage } from "./consultation-types.ts";
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

function numberedReferences(rows: MessageRow[], jobs: ConsultationJob[]): ConsultationNumberedReference[] {
  // 최신 대량 안내가 해석 불가하면 이전 안내의 번호로 대체하지 않는다.
  const notice = rows.filter((row) => row.direction === "outbound" && row.sent_by === "system-bulk")
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id))[0];
  const allowed = jobs.filter((job) => !job.expired && job.stage !== "paused" && job.stage !== "abort");
  if (!notice || !allowed.some((job) => job.job_id === notice.job_id) || ADVERTISEMENT_PREFIX.test(notice.body)) return [];
  const headings = [...notice.body.matchAll(/^\s*([①-⑳]|\d{1,2}[.)])\s*([^\n:：]+)(?:[:：]|$)/gm)];
  if (headings.length < 2) return [];
  const normalize = (text: string) => text.replace(/[^0-9A-Za-z가-힣]/g, "").toLowerCase();
  const options: ConsultationNumberedReference["options"] = [];
  for (const heading of headings) {
    const number = /^[①-⑳]$/.test(heading[1]) ? heading[1].charCodeAt(0) - "①".charCodeAt(0) + 1 : Number.parseInt(heading[1], 10);
    const label = heading[2].trim();
    const token = normalize(label);
    const matches = allowed.filter((job) => token.length >= 2 && normalize(`${job.title} ${job.branch ?? ""}`).includes(token));
    // 일부 공고만 남기면 같은 번호 안내의 범위·순서를 오해할 수 있다.
    if (matches.length !== 1 || options.some((option) => option.number === number || option.job_id === matches[0].job_id)) return [];
    options.push({ number, job_id: matches[0].job_id, label });
  }
  return [{ source_message_id: notice.id, created_at: notice.created_at, options }];
}

/** 공고를 가로지른 실제 상담 문맥과 아직 답하지 않은 수신 원문만 읽는다. */
export async function loadConsultationHistory(
  supabase: SupabaseClient,
  applicantId: number,
  current: ConsultationSourceMessage,
  jobs: ConsultationJob[],
): Promise<{ history: ConversationTurn[]; sourceMessages: ConsultationSourceMessage[]; numberedReferences: ConsultationNumberedReference[]; ambiguousFollowup: boolean }> {
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
    numberedReferences: numberedReferences(data as MessageRow[], jobs),
    ambiguousFollowup: Boolean(lastOutbound && (lastOutbound.job_id == null || matchJobsByText(lastOutbound.body, jobs).length > 1)),
  };
}
