import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { fetchAllPostgrestRows } from "@/lib/admin/postgrest-pagination";
import {
  STAFFING_PREPARATION_EVENT,
  parseStaffingPreparation,
  type StaffingPreparationSnapshot,
} from "@/lib/admin/staffing-preparation";

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

function snapshot(applicantId: number, event?: PreparationEvent): StaffingPreparationSnapshot {
  const preparation = event ? parseStaffingPreparation(event.meta) : null;
  return { applicant_id: applicantId, preparation, event_id: event?.id ?? null,
    updated_at: event?.created_at ?? null, invalid: Boolean(event && !preparation) };
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
    const latest = new Map<number, PreparationEvent>();
    for (let offset = 0; offset < applicantIds.length; offset += 250) {
      const ids = applicantIds.slice(offset, offset + 250);
      const events = await fetchAllPostgrestRows(async (from, to) => {
        const result = await db.from("pool_events").select(EVENT_COLUMNS).eq("job_id", jobId)
          .eq("event_type", STAFFING_PREPARATION_EVENT).in("applicant_id", ids)
          .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
        return { data: result.data as PreparationEvent[] | null, error: result.error };
      }, "운영 준비 기록");
      // 손상된 최신 기록도 그대로 표시한다. 과거의 유효한 기록으로 되돌아가지 않는다.
      for (const event of events) if (!latest.has(event.applicant_id)) latest.set(event.applicant_id, event);
    }
    return NextResponse.json({ preparations: applicantIds.map((id) => snapshot(id, latest.get(id))) });
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
    if (typeof applicantId !== "number" || !Number.isSafeInteger(applicantId) || applicantId <= 0
      || !UUID.test(actionKey) || !preparation) {
      return NextResponse.json({ error: "후보·요청 키·날짜별 가능 여부를 확인해주세요. 날짜는 31개, 교육 메모는 240자, 운영 메모는 1000자까지입니다." }, { status: 400 });
    }
    const db = createServiceClient();
    const candidate = await db.from("job_candidates").select("id").eq("job_id", jobId).eq("applicant_id", applicantId).maybeSingle();
    if (candidate.error) throw candidate.error;
    if (!candidate.data) return NextResponse.json({ error: "이 공고에 연결된 후보만 준비 내용을 저장할 수 있습니다." }, { status: 404 });
    // append-only 검토 기록. 기존 action_key unique index가 같은 요청의 동시 INSERT를 막는다.
    // 다른 키의 편집은 모두 보존하며 GET의 created_at/id 순서로 최신 값을 표시한다.
    const inserted = await db.from("pool_events").insert({ applicant_id: applicantId, job_id: jobId,
      event_type: STAFFING_PREPARATION_EVENT, action_key: actionKey, meta: preparation }).select(EVENT_COLUMNS).single();
    if (inserted.error?.code === "23505") {
      const existing = await db.from("pool_events").select(EVENT_COLUMNS).eq("action_key", actionKey).maybeSingle();
      if (existing.error) throw existing.error;
      const row = existing.data as PreparationEvent | null;
      if (!row || row.applicant_id !== applicantId || row.job_id !== jobId || row.event_type !== STAFFING_PREPARATION_EVENT
        || JSON.stringify(parseStaffingPreparation(row.meta)) !== JSON.stringify(preparation)) {
        return NextResponse.json({ error: "같은 요청 키를 다른 준비 내용에 사용할 수 없습니다." }, { status: 409 });
      }
      return NextResponse.json({ ...snapshot(applicantId, row), deduplicated: true });
    }
    if (inserted.error || !inserted.data) throw inserted.error ?? new Error("missing saved event");
    return NextResponse.json({ ...snapshot(applicantId, inserted.data as PreparationEvent), deduplicated: false });
  } catch (error) {
    console.error("[staffing-preparation POST]", error);
    return NextResponse.json({ error: "운영 준비 기록을 저장하지 못했습니다. 같은 요청으로 다시 시도해주세요." }, { status: 503 });
  }
}
