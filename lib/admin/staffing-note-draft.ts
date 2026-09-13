import {
  STAFFING_PREPARATION_LIMITS, backupIntentLabels, emptyStaffingFollowUp, followUpContactMethodLabels,
  parseStaffingPreparation, participationKindLabels, staffingToday, trainingStatusLabels,
} from "./staffing-preparation.ts";
import type { StaffingFollowUp, StaffingParticipationRecord, StaffingPreparation } from "./staffing-preparation.ts";

type Change<Field extends string, Value> = { field: Field; value: Value; evidence: string };
export type StaffingNoteChange =
  | Change<"contact", NonNullable<StaffingFollowUp["last_contact"]>>
  | Change<"training_availability", string>
  | Change<"training_status", "coordinating" | "completed" | "on_hold">
  | Change<"backup_intent", "interested" | "declined">
  | Change<"next_action", string>
  | Change<"due_date", string>
  | Change<"participation", Omit<StaffingParticipationRecord, "id">>;
export type StaffingNoteProposal = { changes: StaffingNoteChange[]; questions: string[] };

function exactRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
    ? value as Record<string, unknown> : null;
}
function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
function boundedText(value: unknown, limit: number, nonempty = false): value is string {
  return typeof value === "string" && value.length <= limit && (!nonempty || Boolean(value.trim()));
}
function parseChange(raw: unknown, referenceDate: string, note?: string): StaffingNoteChange | null {
  const change = exactRecord(raw, ["field", "value", "evidence"]);
  if (!change || typeof change.evidence !== "string" || !change.evidence.trim()
    || (note !== undefined && !note.includes(change.evidence))) return null;
  const { field, value, evidence } = change;
  switch (field) {
    case "contact": {
      const contact = exactRecord(value, ["date", "method", "result"]);
      if (!contact || !validDay(contact.date) || contact.date > referenceDate
        || (contact.method !== "phone" && contact.method !== "sms" && contact.method !== "other")
        || !boundedText(contact.result, STAFFING_PREPARATION_LIMITS.followUpResult, true)) return null;
      return { field, value: { date: contact.date, method: contact.method, result: contact.result.trim() }, evidence };
    }
    case "training_availability":
      return boundedText(value, STAFFING_PREPARATION_LIMITS.training) ? { field, value: value.trim(), evidence } : null;
    case "training_status":
      return value === "coordinating" || value === "completed" || value === "on_hold" ? { field, value, evidence } : null;
    case "backup_intent":
      return value === "interested" || value === "declined" ? { field, value, evidence } : null;
    case "next_action":
      return boundedText(value, STAFFING_PREPARATION_LIMITS.followUpAction, true) ? { field, value: value.trim(), evidence } : null;
    case "due_date":
      return validDay(value) ? { field, value, evidence } : null;
    case "participation": {
      const participation = exactRecord(value, ["kind", "date", "note"]);
      if (!participation || (participation.kind !== "training" && participation.kind !== "backup")
        || !validDay(participation.date) || participation.date > referenceDate
        || !boundedText(participation.note, STAFFING_PREPARATION_LIMITS.note)) return null;
      return { field, value: { kind: participation.kind, date: participation.date, note: participation.note.trim() }, evidence };
    }
    default: return null;
  }
}
function parseChanges(raw: unknown, referenceDate: string, note?: string): StaffingNoteChange[] | null {
  if (!Array.isArray(raw) || raw.length > 12) return null;
  const changes: StaffingNoteChange[] = [];
  const seen = new Set<StaffingNoteChange["field"]>();
  for (const item of raw) {
    const change = parseChange(item, referenceDate, note);
    if (!change || (change.field !== "participation" && seen.has(change.field))) return null;
    seen.add(change.field);
    changes.push(change);
  }
  return changes;
}

/** AI evidence supports review; only the manager can apply and save these changes. */
export function parseStaffingNoteProposal(raw: unknown, note: string, referenceDate: string): StaffingNoteProposal | null {
  const proposal = exactRecord(raw, ["changes", "questions"]);
  if (!proposal || typeof note !== "string" || !note.trim() || !validDay(referenceDate)
    || !Array.isArray(proposal.questions) || proposal.questions.length > 5
    || !proposal.questions.every((question) => boundedText(question, 240, true))) return null;
  const changes = parseChanges(proposal.changes, referenceDate, note);
  if (!changes || (changes.some((change) => change.field === "due_date") && !changes.some((change) => change.field === "next_action"))) return null;
  return { changes, questions: proposal.questions.map((question: string) => question.trim()) };
}

/** Applies a manager-selected subset locally without changing unrelated manager decisions. */
export function applyStaffingNoteChanges(current: StaffingPreparation, selected: StaffingNoteChange[]): StaffingPreparation | null {
  const changes = parseChanges(selected, staffingToday());
  if (!changes) return null;
  const next = { ...current, training: { ...current.training }, records: [...current.records] };
  const nextAction = changes.find((change) => change.field === "next_action");
  const dueDate = changes.find((change) => change.field === "due_date");
  if (changes.some((change) => change.field === "contact") || nextAction || dueDate) {
    next.follow_up = { ...(current.follow_up ?? emptyStaffingFollowUp()) };
    if (nextAction && nextAction.value !== next.follow_up.next_action) {
      next.follow_up.next_action = nextAction.value;
      next.follow_up.status = "open";
      next.follow_up.due_date = "";
    }
    if (dueDate) {
      if (!next.follow_up.next_action.trim()) return null;
      next.follow_up.due_date = dueDate.value;
    }
  }
  for (const change of changes) {
    switch (change.field) {
      case "contact": next.follow_up!.last_contact = { ...change.value }; break;
      case "training_availability": next.training_availability = change.value; break;
      case "training_status": next.training.status = change.value; break;
      case "backup_intent": next.training.backup_intent = change.value; break;
      case "participation":
        if (!next.records.some((record) => record.kind === change.value.kind && record.date === change.value.date)) {
          if (next.records.length >= STAFFING_PREPARATION_LIMITS.records) return null;
          next.records.push({ id: crypto.randomUUID(), ...change.value });
        }
        break;
    }
  }
  // Validate the merged shape while retaining exact existing notes, order and legacy omissions.
  return parseStaffingPreparation(next) ? next : null;
}

export function staffingNoteChangeLabel(change: StaffingNoteChange): string {
  return { contact: "최근 연락", training_availability: "선탑 가능 시간", training_status: "선탑 진행 상태",
    backup_intent: "백업 진행 의사", next_action: "다음 할 일", due_date: "연락 기한", participation: "실제 참여 이력" }[change.field];
}
export function staffingNoteChangeValue(change: StaffingNoteChange): string {
  switch (change.field) {
    case "contact": return `${change.value.date} · ${followUpContactMethodLabels[change.value.method]} · ${change.value.result}`;
    case "training_status": return trainingStatusLabels[change.value];
    case "backup_intent": return backupIntentLabels[change.value];
    case "participation": return `${participationKindLabels[change.value.kind]} · ${change.value.date}${change.value.note ? ` · ${change.value.note}` : ""}`;
    default: return change.value;
  }
}
