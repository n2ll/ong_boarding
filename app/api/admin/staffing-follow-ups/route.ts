import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { fetchAllPostgrestRows } from "@/lib/admin/postgrest-pagination";
import { STAFFING_PREPARATION_EVENT } from "@/lib/admin/staffing-preparation";
import {
  buildStaffingFollowUps, isStaffingFollowUpJob,
  type StaffingFollowUpJob, type StaffingFollowUpCandidate, type StaffingFollowUpEvent,
} from "@/lib/admin/staffing-follow-ups";

export const dynamic = "force-dynamic";

/** Admin session authentication is enforced by middleware, as for the other admin GET routes. */
export async function GET() {
  try {
    const db = createServiceClient();
    const jobs = (await fetchAllPostgrestRows(async (from, to) => {
      const result = await db.from("jobs").select("id, title").order("id", { ascending: true }).range(from, to);
      return { data: result.data as StaffingFollowUpJob[] | null, error: result.error };
    }, "후속 연락 공고")).filter(isStaffingFollowUpJob);
    const candidates: StaffingFollowUpCandidate[] = [];
    const events: StaffingFollowUpEvent[] = [];
    for (let offset = 0; offset < jobs.length; offset += 250) {
      const jobIds = jobs.slice(offset, offset + 250).map((job) => job.id);
      const [links, history] = await Promise.all([
        fetchAllPostgrestRows(async (from, to) => {
          const result = await db.from("job_candidates").select("id, applicant_id, job_id, applicants:applicant_id(name)")
            .in("job_id", jobIds).order("id", { ascending: true }).range(from, to);
          return { data: result.data as StaffingFollowUpCandidate[] | null, error: result.error };
        }, "후속 연락 후보"),
        fetchAllPostgrestRows(async (from, to) => {
          const result = await db.from("pool_events").select("id, applicant_id, job_id, event_type, meta, created_at")
            .eq("event_type", STAFFING_PREPARATION_EVENT).in("job_id", jobIds)
            .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
          return { data: result.data as StaffingFollowUpEvent[] | null, error: result.error };
        }, "후속 연락 기록"),
      ]);
      candidates.push(...links);
      events.push(...history);
    }
    return NextResponse.json(buildStaffingFollowUps({ jobs, candidates, events }));
  } catch (error) {
    console.error("[staffing-follow-ups GET]", error);
    return NextResponse.json({ error: "후속 연락 할 일을 확인하지 못했습니다. 다시 조회해주세요." }, { status: 503 });
  }
}
