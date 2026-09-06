import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConsultationObservation, ConsultationSourceMessage } from "./consultation-types.ts";

const EVENT_TYPE = "job_consultation_observation";
const KEY_BATCH_SIZE = 100;

interface ObservationEvent {
  applicant_id: number;
  job_id: number;
  event_type: typeof EVENT_TYPE;
  action_key: string;
  meta: {
    source: "inbound_sms";
    source_message_id: string;
    source_created_at: string;
    observations: { kind: ConsultationObservation["kind"]; quote: string }[];
  };
}

function observationActionKey(messageId: string, jobId: number): string {
  const bytes = createHash("sha256").update(JSON.stringify([EVENT_TYPE, messageId, jobId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** JSONB의 키 순서와 모델의 항목 순서가 달라도 같은 관찰은 같은 기록이다. */
function sameEvent(existing: ObservationEvent, intended: ObservationEvent): boolean {
  const meta = existing.meta;
  if (existing.applicant_id !== intended.applicant_id || existing.job_id !== intended.job_id
    || existing.event_type !== EVENT_TYPE || meta?.source !== "inbound_sms"
    || meta.source_message_id !== intended.meta.source_message_id
    || meta.source_created_at !== intended.meta.source_created_at
    || !Array.isArray(meta.observations)) return false;
  const canonical = (items: ObservationEvent["meta"]["observations"]) => items.map((item) => JSON.stringify([item?.kind, item?.quote])).sort();
  return JSON.stringify(canonical(meta.observations)) === JSON.stringify(canonical(intended.meta.observations));
}

/** 이미 검증된 상담의 수신 원문을 재검증해 기록한다. 자동 모드 여부는 호출자가 보장한다. */
export async function saveConsultationObservations(
  supabase: SupabaseClient,
  applicantId: number,
  observations: ConsultationObservation[],
  sources: ConsultationSourceMessage[],
): Promise<void> {
  if (observations.length === 0) return;
  if (!Number.isSafeInteger(applicantId) || applicantId <= 0) throw new Error("관찰 지원자가 유효하지 않습니다.");
  const sourceById = new Map<string, ConsultationSourceMessage>();
  for (const source of sources) {
    const previous = sourceById.get(source.id);
    if (previous && (previous.body !== source.body || previous.created_at !== source.created_at)) {
      throw new Error("관찰 원문 문자 ID가 충돌합니다.");
    }
    sourceById.set(source.id, source);
  }
  const events = new Map<string, ObservationEvent>();
  // 전체 입력을 먼저 검사한다. 뒤쪽 원문이 잘못됐는데 앞쪽 발언만 접수되면 안 된다.
  for (const observation of observations) {
    const source = sourceById.get(observation.source_message_id);
    if (!Number.isSafeInteger(observation.job_id) || observation.job_id <= 0
      || (observation.kind !== "interest" && observation.kind !== "availability")
      || typeof observation.quote !== "string" || !observation.quote.trim()
      || !source || typeof source.id !== "string" || !source.id.trim()
      || typeof source.body !== "string" || !source.body.includes(observation.quote)
      || !Number.isFinite(Date.parse(source.created_at))) {
      throw new Error("공고별 관찰이 수신 원문과 일치하지 않습니다.");
    }
    const key = observationActionKey(source.id, observation.job_id);
    let event = events.get(key);
    if (!event) {
      event = {
        applicant_id: applicantId,
        job_id: observation.job_id,
        event_type: EVENT_TYPE,
        action_key: key,
        meta: { source: "inbound_sms", source_message_id: source.id, source_created_at: source.created_at, observations: [] },
      };
      events.set(key, event);
    }
    if (!event.meta.observations.some((item) => item.kind === observation.kind && item.quote === observation.quote)) {
      event.meta.observations.push({ kind: observation.kind, quote: observation.quote });
    }
  }

  const rows = [...events.values()];
  // action_key는 partial unique index라 PostgREST on_conflict 지정으로 추론할 수 없다.
  // 첫 일괄 INSERT는 원자적이다. 중복 시 기존 원문을 검증하고 미기록분만 한 번 더 시도한다.
  const { error } = await supabase.from("pool_events").insert(rows);
  if (!error) return;
  if (error.code !== "23505") throw new Error(`상담 관찰 기록 실패: ${error.message}`);

  const remaining = new Map(events);
  for (let offset = 0; offset < rows.length; offset += KEY_BATCH_SIZE) {
    const { data, error: readError } = await supabase.from("pool_events")
      .select("applicant_id, job_id, event_type, action_key, meta")
      .in("action_key", rows.slice(offset, offset + KEY_BATCH_SIZE).map((row) => row.action_key));
    if (readError || !data) throw new Error(`상담 관찰 중복 확인 실패: ${readError?.message ?? "invalid response"}`);
    for (const existing of data as ObservationEvent[]) {
      const intended = events.get(existing.action_key);
      if (!intended || !sameEvent(existing, intended)) throw new Error("이미 기록된 상담 관찰과 내용이 충돌합니다.");
      remaining.delete(existing.action_key);
    }
  }
  if (remaining.size === 0) return;
  const { error: retryError } = await supabase.from("pool_events").insert([...remaining.values()]);
  if (retryError) throw new Error(`상담 관찰 기록 실패: ${retryError.message}`);
}
