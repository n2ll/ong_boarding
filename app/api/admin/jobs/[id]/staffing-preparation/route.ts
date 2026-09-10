import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createServiceClient } from "@/lib/supabase";
import { fetchAllPostgrestRows } from "@/lib/admin/postgrest-pagination";
import {
  STAFFING_PREPARATION_EVENT,
  STAFFING_PREPARATION_LIMITS,
  type StaffingPreparationActor,
  STAFFING_OBSERVATION_EVENT,
  buildStaffingSuggestions,
  type StaffingSourceMessage,
  type StaffingPrimaryCandidate,
  parseStaffingPreparation,
  type StaffingPreparationSnapshot,
} from "@/lib/admin/staffing-preparation";

import { isGeneralLineJob, joinedClientType } from "@/lib/agent/general-line";
import { isJobEffectivelyClosed } from "@/lib/jobs";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
type PreparationEvent = { id: number; applicant_id: number; job_id: number; event_type: string; meta: unknown; created_at: string };
const EVENT_COLUMNS = "id, applicant_id, job_id, event_type, meta, created_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function jobIdFrom(context: Context): Promise<number | null> {
  const { id } = await context.params;
  const value = Number(id);
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(value) ? value : null;
}

function author(event?: PreparationEvent): StaffingPreparationActor | null {
  const meta = event?.meta as { actor?: StaffingPreparationActor } | null;
  return typeof meta?.actor?.account_id === "string" && typeof meta.actor.name === "string" ? meta.actor : null;
}

function snapshot(applicantId: number, event?: PreparationEvent, history: PreparationEvent[] = event ? [event] : []): StaffingPreparationSnapshot {
  const preparation = event ? parseStaffingPreparation(event.meta) : null;
  return { applicant_id: applicantId, preparation, event_id: event?.id ?? null,
    updated_at: event?.created_at ?? null, invalid: Boolean(event && !preparation), actor: author(event),
    history: history.map((row) => ({ event_id: row.id, updated_at: row.created_at, actor: author(row),
      preparation: parseStaffingPreparation(row.meta), invalid: !parseStaffingPreparation(row.meta) })) };
}

export async function GET(_req: NextRequest, context: Context) {
  try {
    const jobId = await jobIdFrom(context);
    if (jobId === null) return NextResponse.json({ error: "올바른 공고를 선택해주세요." }, { status: 400 });
    const db = createServiceClient();
    const candidates = await fetchAllPostgrestRows(async (from, to) => {
      const result = await db.from("job_candidates").select("id, applicant_id").eq("job_id", jobId)
        .order("id", { ascending: true }).range(from, to);
      return { data: result.data as Array<{ applicant_id: number }> | null, error: result.error };
    }, "공고 후보");
    const applicantIds = [...new Set(candidates.map((row) => row.applicant_id))];
    const allEvents: PreparationEvent[] = [];
    const links: Array<{ applicant_id: number; job_id: number }> = [];
    for (let offset = 0; offset < applicantIds.length; offset += 250) {
      const ids = applicantIds.slice(offset, offset + 250);
      allEvents.push(...await fetchAllPostgrestRows(async (from, to) => {
        const result = await db.from("pool_events").select(EVENT_COLUMNS)
          .in("event_type", [STAFFING_PREPARATION_EVENT, STAFFING_OBSERVATION_EVENT]).in("applicant_id", ids)
          .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
        return { data: result.data as PreparationEvent[] | null, error: result.error };
      }, "운영 준비·수신 관찰 기록"));
      links.push(...await fetchAllPostgrestRows(async (from, to) => {
        const result = await db.from("job_candidates").select("id, applicant_id, job_id").in("applicant_id", ids)
          .order("id", { ascending: true }).range(from, to);
        return { data: result.data as typeof links | null, error: result.error };
      }, "후보의 다른 공고"));
    }
    const jobIds = [...new Set([jobId, ...links.map((link) => link.job_id)])];
    type Job = { id: number; title: string; start_date: string | null; work_period: string | null; client: unknown };
    const jobs: Job[] = [];
    for (let offset = 0; offset < jobIds.length; offset += 250) {
      jobs.push(...await fetchAllPostgrestRows(async (from, to) => {
        const result = await db.from("jobs").select("id, title, start_date, work_period, client:clients(client_type)")
          .in("id", jobIds.slice(offset, offset + 250)).order("id", { ascending: true }).range(from, to);
        return { data: result.data as Job[] | null, error: result.error };
      }, "배차 준비 공고"));
    }
    const currentJob = jobs.find((job) => job.id === jobId);
    if (!currentJob) return NextResponse.json({ error: "공고를 확인하지 못했습니다." }, { status: 404 });
    const observations = allEvents.filter((event) => event.job_id === jobId && event.event_type === STAFFING_OBSERVATION_EVENT);
    const observedApplicantIds = [...new Set(observations.map((event) => event.applicant_id))];
    const messages: StaffingSourceMessage[] = [];
    for (let offset = 0; offset < observedApplicantIds.length; offset += 250) {
      messages.push(...await fetchAllPostgrestRows(async (from, to) => {
        // 직전 선탑 질문과 후속 거절도 읽어 교육 가능시간을 백업 가능일과 구분한다.
        const result = await db.from("messages").select("id, applicant_id, direction, body, created_at")
          .in("applicant_id", observedApplicantIds.slice(offset, offset + 250))
          .order("id", { ascending: true }).range(from, to);
        return { data: result.data as StaffingSourceMessage[] | null, error: result.error };
      }, "관찰 수신 원문과 후속 답장"));
    }
    const memberships = new Set(links.map((link) => `${link.applicant_id}:${link.job_id}`));
    const latest = new Map<string, PreparationEvent>();
    // 손상된 최신 기록도 그대로 표시한다. 과거의 유효한 기록으로 되돌아가지 않는다.
    for (const event of allEvents.filter((row) => row.event_type === STAFFING_PREPARATION_EVENT)) {
      const key = `${event.applicant_id}:${event.job_id}`;
      if (!latest.has(key)) latest.set(key, event);
    }
    const primaryCandidates: StaffingPrimaryCandidate[] = [];
    let conflictCheckIncomplete = links.some((link) => !jobs.some((job) => job.id === link.job_id));
    for (const [key, event] of latest) {
      if (event.job_id === jobId || !memberships.has(key)) continue;
      const job = jobs.find((item) => item.id === event.job_id);
      if (!job || !isGeneralLineJob({ title: job.title, client_type: joinedClientType(job.client) })) continue;
      const preparation = parseStaffingPreparation(event.meta);
      if (!preparation) { conflictCheckIncomplete = true; continue; }
      for (const day of preparation.dates.filter((day) => day.role === "primary_candidate")) {
        primaryCandidates.push({ applicant_id: event.applicant_id, job_id: job.id, job_title: job.title, date: day.date });
      }
    }
    return NextResponse.json({ preparations: applicantIds.map((id) => snapshot(id, latest.get(`${id}:${jobId}`), allEvents.filter((row) => row.event_type === STAFFING_PREPARATION_EVENT && row.job_id === jobId && row.applicant_id === id))),
      suggestions: buildStaffingSuggestions(observations, messages, currentJob),
      primary_candidates: primaryCandidates, conflict_check_incomplete: conflictCheckIncomplete });
  } catch (error) {
    console.error("[staffing-preparation GET]", error);
    return NextResponse.json({ error: "운영 준비 기록을 확인하지 못했습니다." }, { status: 503 });
  }
}

export async function POST(req: NextRequest, context: Context) {
  try {
    const jobId = await jobIdFrom(context);
    if (jobId === null) return NextResponse.json({ error: "올바른 공고를 선택해주세요." }, { status: 400 });
    let body: Record<string, unknown>;
    try {
      const value = await req.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid body");
      body = value;
    } catch { return NextResponse.json({ error: "저장할 내용을 확인해주세요." }, { status: 400 }); }
    const applicantId = body.applicant_id;
    const actionKey = typeof body.action_key === "string" ? body.action_key.trim().toLowerCase() : "";
    const preparation = parseStaffingPreparation({ ...body, source: "manager" });
    const baseEventId = body.base_event_id;
    const actorName = typeof body.actor_name === "string" ? body.actor_name.trim() : "";
    if (typeof applicantId !== "number" || !Number.isSafeInteger(applicantId) || applicantId <= 0
      || !UUID.test(actionKey) || !preparation || !actorName || actorName.length > STAFFING_PREPARATION_LIMITS.actor
      || (baseEventId !== null && (typeof baseEventId !== "number" || !Number.isSafeInteger(baseEventId) || baseEventId <= 0))) {
      return NextResponse.json({ error: "작성자·후보·편집 기준 기록·선탑 정보를 확인해주세요. 날짜는 31개, 선탑 정보는 각 240자, 팀 메모는 1000자까지입니다." }, { status: 400 });
    }
    // Middleware handles session refresh; author attribution must use a verified account, never a submitted account ID.
    const auth = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    });
    const { data: { user }, error: authError } = await auth.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "로그인 상태를 확인한 뒤 다시 저장해주세요." }, { status: 401 });
    const actor: StaffingPreparationActor = { account_id: user.id, name: actorName };
    const db = createServiceClient();
    const candidate = await db.from("job_candidates").select("id, agent_stage").eq("job_id", jobId).eq("applicant_id", applicantId).maybeSingle();
    if (candidate.error) throw candidate.error;
    if (!candidate.data) return NextResponse.json({ error: "이 공고에 연결된 후보만 준비 내용을 저장할 수 있습니다." }, { status: 404 });
    const outdatedConfirmationEditor = () => NextResponse.json({ error: "날짜별 관리자 확정을 보호하기 위해 화면을 새로고침한 뒤 다시 저장해주세요." }, { status: 409 });
    if (body.confirmation_version !== 1 && preparation.dates.some((day) => day.confirmation === "confirmed")) return outdatedConfirmationEditor();
    const readHistory = () => fetchAllPostgrestRows(async (from, to) => {
      const result = await db.from("pool_events").select(EVENT_COLUMNS).eq("applicant_id", applicantId).eq("job_id", jobId)
        .eq("event_type", STAFFING_PREPARATION_EVENT).order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
      return { data: result.data as PreparationEvent[] | null, error: result.error };
    }, "선탑·팀 기록");
    const isRetry = (row: PreparationEvent) => {
      const meta = row.meta as Record<string, unknown>;
      const savedActor = author(row);
      return row.applicant_id === applicantId && row.job_id === jobId && row.event_type === STAFFING_PREPARATION_EVENT
        && meta.request_key === actionKey && meta.base_event_id === baseEventId
        && savedActor?.account_id === actor.account_id && savedActor.name === actor.name
        && JSON.stringify(parseStaffingPreparation(row.meta)) === JSON.stringify(preparation);
    };
    // Check a committed request before its base version: a lost response may be retried after a teammate's later edit.
    const previous = await db.from("pool_events").select(EVENT_COLUMNS).eq("meta->>request_key", actionKey).maybeSingle();
    if (previous.error) throw previous.error;
    if (previous.data) {
      const row = previous.data as PreparationEvent;
      if (!isRetry(row)) return NextResponse.json({ error: "같은 요청 키를 다른 준비 내용에 사용할 수 없습니다." }, { status: 409 });
      return NextResponse.json({ ...snapshot(applicantId, row, await readHistory()), deduplicated: true });
    }
    const history = await readHistory();
    const latestDates = (history[0]?.meta as { dates?: unknown } | null)?.dates;
    if (body.confirmation_version !== 1 && Array.isArray(latestDates)
      && latestDates.some((day) => day && typeof day === "object" && day.confirmation === "confirmed")) return outdatedConfirmationEditor();
    const conflict = (rows: PreparationEvent[]) => NextResponse.json({ conflict: true,
      error: "동료가 먼저 기록을 저장했어요. 최신 기록과 내 입력을 비교한 뒤 다시 정리해주세요.",
      latest: snapshot(applicantId, rows[0], rows) }, { status: 409 });
    // Older open screens omit records from their payload even after reading a newer snapshot.
    if (body.records === undefined && (parseStaffingPreparation(history[0]?.meta)?.records.length ?? 0) > 0) {
      return NextResponse.json({ error: "실제 참여 이력을 보호하기 위해 현재 화면을 새로고침한 뒤 다시 저장해주세요." }, { status: 409 });
    }
    if ((history[0]?.id ?? null) !== baseEventId) return conflict(history);
    const previouslyConfirmed = new Set(parseStaffingPreparation(history[0]?.meta)?.dates
      .filter((day) => day.confirmation === "confirmed").map((day) => day.date));
    const addsConfirmation = preparation.dates.some((day) => day.confirmation === "confirmed" && !previouslyConfirmed.has(day.date));
    if (addsConfirmation) {
      if (candidate.data.agent_stage === "abort") {
        return NextResponse.json({ error: "이 공고에서 종료된 후보입니다. 후보를 되살린 뒤 날짜별 투입을 확정해주세요." }, { status: 409 });
      }
      const job = await db.from("jobs").select("status, closes_at").eq("id", jobId).maybeSingle();
      if (job.error) throw job.error;
      if (!job.data || isJobEffectivelyClosed(job.data.status, job.data.closes_at)) {
        return NextResponse.json({ error: "마감된 공고에는 새 투입을 확정할 수 없습니다. 공고를 다시 연 뒤 진행해주세요." }, { status: 409 });
      }
    }
    // One successor per base version, enforced by the existing unique action_key index, including concurrent INSERTs.
    // Keep the client's retry key in metadata; all old event rows stay intact and new saves append their own notes.
    const hash = createHash("sha256").update(`staffing-preparation:${jobId}:${applicantId}:${baseEventId ?? "initial"}`).digest("hex");
    const versionKey = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const inserted = await db.from("pool_events").insert({ applicant_id: applicantId, job_id: jobId,
      event_type: STAFFING_PREPARATION_EVENT, action_key: versionKey,
      meta: { ...preparation, actor, request_key: actionKey, base_event_id: baseEventId } }).select(EVENT_COLUMNS).single();
    if (inserted.error?.code === "23505") {
      const existing = await db.from("pool_events").select(EVENT_COLUMNS).eq("action_key", versionKey).maybeSingle();
      if (existing.error) throw existing.error;
      const rows = await readHistory();
      const row = existing.data as PreparationEvent | null;
      if (!row || !isRetry(row)) return conflict(rows);
      return NextResponse.json({ ...snapshot(applicantId, row, rows), deduplicated: true });
    }
    if (inserted.error || !inserted.data) throw inserted.error ?? new Error("missing saved event");
    const saved = inserted.data as PreparationEvent;
    return NextResponse.json({ ...snapshot(applicantId, saved, [saved, ...history]), deduplicated: false });
  } catch (error) {
    console.error("[staffing-preparation POST]", error);
    return NextResponse.json({ error: "운영 준비 기록을 저장하지 못했습니다. 같은 요청으로 다시 시도해주세요." }, { status: 503 });
  }
}
