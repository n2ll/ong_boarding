import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type DraftAction = "ignored" | "used" | "edited";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const routeParams = await params;
    const body = (await req.json()) as {
      action: DraftAction;
      used_message_id?: string;
      applicant_id?: number;
      job_id?: number | null;
    };
    if (!["ignored", "used", "edited"].includes(body.action)) {
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
    }
    const applicantId = body.applicant_id;
    const hasJobId = Object.prototype.hasOwnProperty.call(body, "job_id");
    const jobId = body.job_id ?? null;
    if (
      !Number.isSafeInteger(applicantId)
      || !hasJobId
      || (jobId !== null && (!Number.isSafeInteger(jobId) || jobId <= 0))
    ) {
      return NextResponse.json({ error: "지원자·공고 범위가 필요합니다." }, { status: 400 });
    }
    const supabase = createServiceClient();
    let updateQuery = supabase
      .from("message_drafts")
      .update({
        status: body.action,
        used_message_id: body.used_message_id || null,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", routeParams.id)
      .eq("applicant_id", applicantId)
      .is("send_claim_key", null)
      .in("status", ["pending", "need_info"]);
    updateQuery = jobId === null
      ? updateQuery.is("job_id", null)
      : updateQuery.eq("job_id", jobId);
    const { data, error } = await updateQuery.select().maybeSingle();
    if (error) {
      console.error("[drafts/:id] error", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json(
        { error: "현재 지원자·공고의 미처리 초안을 찾지 못했습니다." },
        { status: 409 },
      );
    }
    return NextResponse.json({ data });
  } catch (err) {
    console.error("[drafts/:id] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
