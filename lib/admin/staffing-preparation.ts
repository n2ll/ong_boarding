export const STAFFING_PREPARATION_EVENT = "staffing_preparation";
export const STAFFING_PREPARATION_LIMITS = { dates: 31, records: 200, training: 240, note: 1000, actor: 80 } as const;

export const trainingStatusLabels = { reviewing: "선탑 미검토", coordinating: "일정 조율", scheduled: "선탑 예정", completed: "선탑 완료", on_hold: "보류" } as const;
export const backupIntentLabels = { unknown: "본인 의사 미확인", interested: "본인 진행 희망", declined: "본인 진행 안 함" } as const;
export type StaffingTraining = {
  status: keyof typeof trainingStatusLabels;
  backup_intent: keyof typeof backupIntentLabels;
  /** Manager-entered local time, always serialized with the Korean +09:00 offset. */
  scheduled_at: string;
  first_loading_location: string;
  linked_pro: string;
};
export const emptyStaffingTraining = (): StaffingTraining => ({ status: "reviewing", backup_intent: "unknown", scheduled_at: "", first_loading_location: "", linked_pro: "" });
export type StaffingPreparationActor = { account_id: string; name: string };
export type StaffingPreparationRevision = {
  event_id: number;
  updated_at: string;
  actor: StaffingPreparationActor | null;
  preparation: StaffingPreparation | null;
  invalid: boolean;
};

export type StaffingPreparationDate = {
  date: string;
  availability: "available" | "unavailable" | "unknown";
  role: "primary_candidate" | "reserve_candidate" | "unassigned";
  /** Only an explicit manager decision confirms this date; legacy candidates remain unconfirmed. */
  confirmation?: "unconfirmed" | "confirmed";
};
export const participationKindLabels = { training: "선탑", backup: "백업" } as const;
export type StaffingParticipationRecord = {
  id: string;
  kind: keyof typeof participationKindLabels;
  date: string;
  note: string;
};
export const staffingToday = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
/** Manager-entered plans, explicit date confirmations and actual participation. */
export type StaffingPreparation = {
  source: "manager";
  dates: StaffingPreparationDate[];
  training_availability: string;
  training: StaffingTraining;
  records: StaffingParticipationRecord[];
  note: string;
};
export type StaffingPreparationSnapshot = {
  applicant_id: number;
  preparation: StaffingPreparation | null;
  event_id: number | null;
  updated_at: string | null;
  invalid: boolean;
  actor: StaffingPreparationActor | null;
  history: StaffingPreparationRevision[];
};

export function parseStaffingPreparation(value: unknown): StaffingPreparation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.source !== "manager" || !Array.isArray(data.dates) || data.dates.length > STAFFING_PREPARATION_LIMITS.dates
    || typeof data.training_availability !== "string" || data.training_availability.length > STAFFING_PREPARATION_LIMITS.training
    || typeof data.note !== "string" || data.note.length > STAFFING_PREPARATION_LIMITS.note) return null;
  let training = emptyStaffingTraining();
  if (data.training !== undefined) {
    const value = record(data.training);
    if (!Object.hasOwn(trainingStatusLabels, value.status as string) || !Object.hasOwn(backupIntentLabels, value.backup_intent as string)
      || ["scheduled_at", "first_loading_location", "linked_pro"].some((key) => typeof value[key] !== "string" || (value[key] as string).length > STAFFING_PREPARATION_LIMITS.training)) return null;
    const at = value.scheduled_at as string;
    if (at && (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00\+09:00$/.test(at) || !validDay(at.slice(0, 10)))) return null;
    training = { status: value.status as StaffingTraining["status"], backup_intent: value.backup_intent as StaffingTraining["backup_intent"],
      scheduled_at: at, first_loading_location: (value.first_loading_location as string).trim(), linked_pro: (value.linked_pro as string).trim() };
  }
  const dates: StaffingPreparationDate[] = [];
  const seen = new Set<string>();
  for (const item of data.dates) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { date, availability, role, confirmation } = item as Record<string, unknown>;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(date)) return null;
    const timestamp = Date.parse(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) return null;
    if (availability !== "available" && availability !== "unavailable" && availability !== "unknown") return null;
    if (role !== "primary_candidate" && role !== "reserve_candidate" && role !== "unassigned") return null;
    if (role !== "unassigned" && availability !== "available") return null;
    if (confirmation !== undefined && confirmation !== "unconfirmed" && confirmation !== "confirmed") return null;
    if (confirmation === "confirmed" && (availability !== "available" || role !== "primary_candidate")) return null;
    dates.push({ date, availability, role, ...(confirmation === undefined ? {} : { confirmation }) });
    seen.add(date);
  }
  dates.sort((a, b) => a.date.localeCompare(b.date));
  const records: StaffingParticipationRecord[] = [];
  const ids = new Set<string>();
  const today = staffingToday();
  if (data.records !== undefined) {
    if (!Array.isArray(data.records) || data.records.length > STAFFING_PREPARATION_LIMITS.records) return null;
    for (const item of data.records) {
      const value = record(item);
      if (typeof value.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)
        || !Object.hasOwn(participationKindLabels, value.kind as string)
        || typeof value.date !== "string" || !validDay(value.date) || value.date > today
        || typeof value.note !== "string" || value.note.length > STAFFING_PREPARATION_LIMITS.note) return null;
      const id = value.id.toLowerCase();
      if (ids.has(id)) return null;
      ids.add(id);
      records.push({ id, kind: value.kind as StaffingParticipationRecord["kind"], date: value.date, note: value.note.trim() });
    }
  }
  records.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return { source: "manager", dates, training_availability: data.training_availability.trim(), training, records, note: data.note.trim() };
}

export const STAFFING_OBSERVATION_EVENT = "job_consultation_observation";
export type StaffingEvidenceEvent = { id: number; applicant_id: number; job_id: number; event_type: string; meta: unknown; created_at: string };
export type StaffingSourceMessage = { id: string; applicant_id: number; direction: string; body: string; created_at: string };
export type StaffingSuggestion = {
  applicant_id: number; event_id: number; source_message_id: string | null; source_created_at: string | null;
  quote: string; date: string | null; availability: "available" | "unavailable" | "unknown"; reason: string | null;
  /** Training replies are reviewed separately and never populate backup work dates. */
  kind?: "training";
};
export type StaffingPrimaryCandidate = { applicant_id: number; job_id: number; job_title: string; date: string };

type SuggestionJob = { id: number; title?: string; start_date: string | null; work_period: string | null };
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function validDay(value: string): boolean {
  const stamp = Date.parse(`${value}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}
/** Deliberately accepts only a complete, single-date statement. Other replies remain visible for review. */
function resolveReply(body: string, receivedAt: string, job: SuggestionJob): Pick<StaffingSuggestion, "date" | "availability"> | null {
  // A standalone selection such as “1, 3번” is not an availability clause. Never drop other lines.
  const statement = body.split(/\r?\n/).filter((line) => !/^\s*\d+(?:번)?(?:\s*[,，·]\s*\d+(?:번)?)*번\s*$/.test(line)).join("\n");
  const text = statement.replace(/\s/g, "").replace(/^[네예][,.]?/, "").replace(/[.!。]+$/, "");
  const match = text.match(/^(?:(\d{4})[-/.년])?(?:(\d{1,2})[-/.월])?(\d{1,2})일?(?:에는|은|에|만)?(?:근무|배송)?(가능(?:합니다|해요|해|하다)?|불가(?:합니다)?|불가능(?:합니다|해요)?|가능하지않(?:습니다|아요)|안(?:됩니다|돼요)|못합니다|어렵습니다)$/);
  if (!match || (!match[1] && !match[2] && !/^\d{1,2}일/.test(text)) || !job.start_date || !validDay(job.start_date) || !Number.isFinite(Date.parse(receivedAt))) return null;
  const receivedDay = new Date(Date.parse(receivedAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // No structured end date exists. Cross-month/year or one-day conflicts need manager interpretation.
  if (receivedDay.slice(0, 7) !== job.start_date.slice(0, 7)) return null;
  const year = match[1] ?? job.start_date.slice(0, 4);
  const month = (match[2] ?? job.start_date.slice(5, 7)).padStart(2, "0");
  const date = `${year}-${month}-${match[3].padStart(2, "0")}`;
  if (!validDay(date) || date.slice(0, 7) !== job.start_date.slice(0, 7) || date < job.start_date || date < receivedDay
    || (job.work_period === "하루" && date !== job.start_date)) return null;
  return { date, availability: /^가능(?:합니다|해요|해|하다)?$/.test(match[4]) ? "available" : "unavailable" };
}

/** Latest observation per applicant only: ambiguous/malformed newer evidence must not revive an old positive reply. */
export function buildStaffingSuggestions(events: StaffingEvidenceEvent[], messages: StaffingSourceMessage[], job: SuggestionJob): StaffingSuggestion[] {
  const latest = new Map<number, StaffingEvidenceEvent>();
  const sourceTime = (event: StaffingEvidenceEvent) => {
    const at = record(event.meta).source_created_at;
    return typeof at === "string" && Number.isFinite(Date.parse(at)) ? Date.parse(at) : Date.parse(event.created_at);
  };
  for (const event of [...events].filter((item) => item.job_id === job.id && item.event_type === STAFFING_OBSERVATION_EVENT)
    .sort((a, b) => sourceTime(b) - sourceTime(a) || b.id - a.id)) {
    if (!latest.has(event.applicant_id)) latest.set(event.applicant_id, event);
  }
  const sources = new Map(messages.map((message) => [message.id, message]));
  return [...latest.values()].flatMap((event) => {
    const meta = record(event.meta);
    const observations = Array.isArray(meta.observations) ? meta.observations.map(record) : [];
    const sourceId = typeof meta.source_message_id === "string" ? meta.source_message_id : null;
    const sourceAt = typeof meta.source_created_at === "string" ? meta.source_created_at : null;
    const source = sourceId ? sources.get(sourceId) : undefined;
    const preceding = source ? messages.filter((message) => message.applicant_id === event.applicant_id && message.direction === "outbound" && Date.parse(message.created_at) < Date.parse(source.created_at))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] : undefined;
    const training = /선탑|동승|교육(?!비)/.test(source?.body ?? "") || Boolean(preceding?.direction === "outbound" && job.title
      && preceding.body.includes(job.title) && /선탑|동승|교육(?!비)/.test(preceding.body) && /희망|가능.*(?:날짜|시간)|(?:날짜|시간).*알려/.test(preceding.body));
    const relevant = observations.filter((item) => item.kind === "availability" || (training && item.kind === "interest"));
    if (observations.length && !relevant.length) return [];
    const quotes = relevant.map((item) => typeof item.quote === "string" ? item.quote : "");
    const suggestion: StaffingSuggestion = { applicant_id: event.applicant_id, event_id: event.id,
      source_message_id: sourceId, source_created_at: sourceAt, quote: quotes.filter(Boolean).join(" / "),
      date: null, availability: "unknown", reason: training ? "선탑 참여 의사와 본인이 말한 가능 시간을 확인하고 문자나 전화로 조율해주세요." : "날짜·근무 가능 여부를 원문에서 확인해주세요.",
      ...(training ? { kind: "training" as const } : {}) };
    if (meta.source !== "inbound_sms" || !source || source.applicant_id !== event.applicant_id || source.direction !== "inbound"
      || !sourceAt || !Number.isFinite(Date.parse(sourceAt)) || Date.parse(source.created_at) !== Date.parse(sourceAt)
      || !quotes.length || quotes.some((quote) => !quote || !source.body.includes(quote))) {
      return [{ ...suggestion, reason: "관찰과 수신 원문이 일치하는지 확인이 필요합니다." }];
    }
    // Full source body, rather than an AI-cropped positive quote, decides whether a simple statement is safe to suggest.
    suggestion.quote = source.body;
    const laterReply = messages.filter((message) => message.applicant_id === event.applicant_id && message.direction === "inbound"
      && message.id !== source.id && Date.parse(message.created_at) >= Date.parse(sourceAt))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (laterReply) return [{ ...suggestion, reason: `이후 새 답장이 있어 확인이 필요합니다. 최신 답장: “${laterReply.body}”` }];
    if (training) return [suggestion];
    const resolved = resolveReply(source.body, sourceAt, job);
    return [{ ...suggestion, ...(resolved ?? {}), reason: resolved ? null : suggestion.reason }];
  });
}

/** Explicit manager action adds a candidate date; any existing date (including unknown) remains untouched. */
export function applyStaffingSuggestion(preparation: StaffingPreparation, suggestion: StaffingSuggestion): StaffingPreparation {
  if (suggestion.kind === "training" || !suggestion.date || suggestion.availability === "unknown" || preparation.dates.some((day) => day.date === suggestion.date)
    || preparation.dates.length >= STAFFING_PREPARATION_LIMITS.dates) return preparation;
  return { ...preparation, dates: [...preparation.dates, { date: suggestion.date, availability: suggestion.availability, role: "unassigned" }] };
}
