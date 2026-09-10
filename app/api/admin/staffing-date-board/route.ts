import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { fetchAllPostgrestRows } from "@/lib/admin/postgrest-pagination";
import { STAFFING_PREPARATION_EVENT } from "@/lib/admin/staffing-preparation";
import { type StaffingDemandEvent } from "@/lib/admin/staffing-demand";
import {
  buildStaffingDateBoard, isStaffingDateBoardJob, staffingDateBoardDates,
  type StaffingDateBoardJob, type StaffingDateBoardCandidate, type StaffingDateBoardEvent,
} from "@/lib/admin/staffing-date-board";

export const dynamic = "force-dynamic";

/** Admin session authentication is enforced by middleware, as for the other admin GET routes. */
export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const start = params.get("start");
  const end = params.get("end");
  if (!start || !end || !staffingDateBoardDates(start, end)) {
    return NextResponse.json({ error: "비교 기간은 올바른 날짜로 1~7일을 선택해주세요." }, { status: 400 });
  }
  try {
    const db = createServiceClient();
    const jobs = (await fetchAllPostgrestRows(async (from, to) => {
      const result = await db.from("jobs")
        .select("id, title, slot, start_date, capacity, status, closes_at, client:clients(client_type)")
        .eq("status", "active").order("id", { ascending: true }).range(from, to);
      return { data: result.data as StaffingDateBoardJob[] | null, error: result.error };
    }, "충원 비교 공고")).filter(isStaffingDateBoardJob);
    const candidates: StaffingDateBoardCandidate[] = [];
    const events: StaffingDateBoardEvent[] = [];
    const demands: StaffingDemandEvent[] = [];
    for (let offset = 0; offset < jobs.length; offset += 250) {
      const jobIds = jobs.slice(offset, offset + 250).map((job) => job.id);
      // Complete both required datasets; a missing page must not masquerade as an unfilled line.
      const [links, history, demandHistory] = await Promise.all([
        fetchAllPostgrestRows(async (from, to) => {
          const result = await db.from("job_candidates")
            .select("id, applicant_id, job_id, agent_stage, applicants:applicant_id(name)")
            .in("job_id", jobIds).order("id", { ascending: true }).range(from, to);
          return { data: result.data as StaffingDateBoardCandidate[] | null, error: result.error };
        }, "충원 비교 후보"),
        fetchAllPostgrestRows(async (from, to) => {
          const result = await db.from("pool_events").select("id, applicant_id, job_id, event_type, meta, created_at")
            .eq("event_type", STAFFING_PREPARATION_EVENT).in("job_id", jobIds)
            .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
          return { data: result.data as StaffingDateBoardEvent[] | null, error: result.error };
        }, "충원 비교 관리자 기록"),
        fetchAllPostgrestRows(async (from, to) => {
          const result = await db.from("job_staffing_demand_events")
            .select("id, job_id, work_date, state, required_count")
            .in("job_id", jobIds).gte("work_date", start).lte("work_date", end)
            .order("id", { ascending: false }).range(from, to);
          return { data: result.data as StaffingDemandEvent[] | null, error: result.error };
        }, "날짜별 운행 수요"),
      ]);
      candidates.push(...links);
      events.push(...history);
      demands.push(...demandHistory);
    }
    return NextResponse.json(buildStaffingDateBoard({ start, end, jobs, candidates, events, demands, updated_at: new Date().toISOString() }));
  } catch (error) {
    console.error("[staffing-date-board GET]", error);
    return NextResponse.json({ error: "날짜별 충원 비교를 확인하지 못했습니다. 다시 조회해주세요." }, { status: 503 });
  }
}
