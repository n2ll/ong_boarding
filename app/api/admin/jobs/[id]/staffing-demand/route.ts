import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createServiceClient } from "@/lib/supabase";
import { isStaffingDateBoardJob, type StaffingDateBoardJob } from "@/lib/admin/staffing-date-board";
import { isStaffingDemandDate, parseStaffingDemand, type StaffingDemandEvent } from "@/lib/admin/staffing-demand";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const TABLE = "job_staffing_demand_events";
const COLUMNS = "id, job_id, work_date, state, required_count, base_event_id, request_key, actor, created_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const jobId = Number(id);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(jobId)) {
      return NextResponse.json({ error: "올바른 공고를 선택해주세요." }, { status: 400 });
    }
    let body: Record<string, unknown>;
    try {
      const value = await req.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid body");
      body = value;
    } catch { return NextResponse.json({ error: "저장할 내용을 확인해주세요." }, { status: 400 }); }
    const demand = parseStaffingDemand(body);
    const date = body.date;
    const baseEventId = body.base_event_id;
    const actionKey = typeof body.action_key === "string" ? body.action_key.trim().toLowerCase() : "";
    const actorName = typeof body.actor_name === "string" ? body.actor_name.trim() : "";
    if (!demand || !isStaffingDemandDate(date) || !UUID.test(actionKey) || !actorName || actorName.length > 80
      || (baseEventId !== null && (typeof baseEventId !== "number" || !Number.isSafeInteger(baseEventId) || baseEventId <= 0))) {
      return NextResponse.json({ error: "날짜·운행 여부·필요 인원·작성자를 확인해주세요. 운행 시 필요 인원은 1~999명, 작성자는 80자까지 입력해주세요." }, { status: 400 });
    }
    const auth = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    });
    const { data: { user }, error: authError } = await auth.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "로그인 상태를 확인한 뒤 다시 저장해주세요." }, { status: 401 });
    const actor = { account_id: user.id, name: actorName };
    const db = createServiceClient();
    const latest = async (): Promise<StaffingDemandEvent | null> => {
      const result = await db.from(TABLE).select(COLUMNS).eq("job_id", jobId).eq("work_date", date)
        .order("id", { ascending: false }).limit(1).maybeSingle();
      if (result.error) throw result.error;
      return result.data as StaffingDemandEvent | null;
    };
    const previousRequest = async (): Promise<StaffingDemandEvent | null> => {
      const result = await db.from(TABLE).select(COLUMNS).eq("request_key", actionKey).maybeSingle();
      if (result.error) throw result.error;
      return result.data as StaffingDemandEvent | null;
    };
    const isRetry = (event: StaffingDemandEvent) => event.job_id === jobId && event.work_date === date
      && event.base_event_id === baseEventId && event.request_key === actionKey
      && event.actor?.account_id === actor.account_id && event.actor.name === actor.name
      && event.state === demand.state && event.required_count === demand.required_count;
    const conflict = async (error: string) => NextResponse.json({ error, latest: await latest() }, { status: 409 });
    const retryConflict = "같은 요청 키를 다른 수요 내용에 사용할 수 없습니다.";
    const versionConflict = "동료가 먼저 수요를 저장했어요. 최신 수요와 내 입력을 비교한 뒤 다시 정리해주세요.";

    // A committed retry stays successful even after a later edit or the job closing.
    const previous = await previousRequest();
    if (previous) return isRetry(previous) ? NextResponse.json({ event: previous }) : await conflict(retryConflict);

    const job = await db.from("jobs").select("id, title, slot, start_date, capacity, status, closes_at, client:clients(client_type)")
      .eq("id", jobId).maybeSingle();
    if (job.error) throw job.error;
    if (!job.data) return NextResponse.json({ error: "공고를 확인하지 못했습니다." }, { status: 404 });
    if (!isStaffingDateBoardJob(job.data as StaffingDateBoardJob)) {
      return await conflict("모집 중인 일반 배송 공고만 날짜별 수요를 입력할 수 있습니다.");
    }
    const current = await latest();
    if ((current?.id ?? null) !== baseEventId) {
      // The same request may have committed between the retry lookup and the version read.
      const committed = await previousRequest();
      if (committed && isRetry(committed)) return NextResponse.json({ event: committed });
      return NextResponse.json({ error: committed ? retryConflict : versionConflict, latest: current }, { status: 409 });
    }
    // The unique successor index arbitrates concurrent saves after the version read.
    const inserted = await db.from(TABLE).insert({ job_id: jobId, work_date: date, ...demand,
      base_event_id: baseEventId, request_key: actionKey, actor }).select(COLUMNS).single();
    if (inserted.error?.code === "23505") {
      const winner = await previousRequest();
      if (winner && isRetry(winner)) return NextResponse.json({ event: winner });
      return await conflict(winner ? retryConflict : versionConflict);
    }
    if (inserted.error) throw inserted.error;
    if (!inserted.data) throw new Error("Saved demand record was not returned");
    return NextResponse.json({ event: inserted.data });
  } catch (error) {
    console.error("[staffing-demand POST]", error);
    return NextResponse.json({ error: "날짜별 수요를 저장하지 못했습니다. 입력 내용을 유지한 채 다시 시도해주세요." }, { status: 503 });
  }
}
