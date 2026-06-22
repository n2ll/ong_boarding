/**
 * POST /api/admin/inbox/[id]/classify
 *
 * body: { action: 'baemin' | 'other' }
 *
 * - 'baemin': triage 재실행해 파싱 → applicants 생성 (source='baemin', status='스크리닝')
 *             + ensureBaeminSystemJob + job_candidates(stage='screening') 생성
 *             + router 호출 (AI 응대 즉시 시작)
 *             + 동일 phone의 다른 pending 메시지도 함께 classification='baemin' + applicant_id 연결
 * - 'other' : classification='other'로만 마킹 (대상 메시지만)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { triageInbound } from "@/lib/agent/baemin-triage";
import { ensureBaeminSystemJob } from "@/lib/agent/baemin-job";
import { runAgentForCandidate } from "@/lib/agent/router";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { action } = (await req.json()) as { action?: "baemin" | "other" };
    if (action !== "baemin" && action !== "other") {
      return NextResponse.json({ error: "action: 'baemin' or 'other'" }, { status: 400 });
    }

    const supabase = createServiceClient();
    const { data: msg, error: msgErr } = await supabase
      .from("messages")
      .select("id, applicant_phone, body, created_at")
      .eq("id", params.id)
      .single();
    if (msgErr || !msg) {
      return NextResponse.json({ error: "message not found" }, { status: 404 });
    }

    if (action === "other") {
      await supabase
        .from("messages")
        .update({ classification: "other" })
        .eq("id", msg.id);
      return NextResponse.json({ ok: true, action: "other" });
    }

    // action === 'baemin'
    const phone = msg.applicant_phone as string;
    const body = msg.body as string;

    // 이미 같은 phone으로 applicants가 있다면 (중복 정정 등) 재생성 skip
    const { data: existingApp } = await supabase
      .from("applicants")
      .select("id")
      .eq("phone", phone)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let applicantId: number | null = existingApp?.id ?? null;
    let triageRes: Awaited<ReturnType<typeof triageInbound>> | null = null;

    if (!applicantId) {
      // 새 applicant 생성
      triageRes = await triageInbound({ phone, body });
      const ext = triageRes.extracted;
      const PH = "미확인";
      const { data: newApp, error: appErr } = await supabase
        .from("applicants")
        .insert({
          name: ext.name?.trim() || "(이름 미확인)",
          phone,
          birth_date: PH,
          location: PH,
          own_vehicle: PH,
          license_type: PH,
          vehicle_type: ext.vehicle?.trim() || PH,
          branch1: PH,
          branch: PH,
          work_hours: ext.time_raw?.trim() || PH,
          available_date: PH,
          self_ownership: PH,
          source: "baemin",
          status: "스크리닝 중",
          filter_pass: null,
          introduction: ext.experience?.trim() || null,
          note: `매니저 수동 분류 (배민): ${triageRes.reasoning}`,
        })
        .select("id, work_hours")
        .single();
      if (appErr || !newApp) {
        console.error("[inbox/classify baemin] applicant create error", appErr);
        return NextResponse.json({ error: "applicant 생성 실패" }, { status: 500 });
      }
      applicantId = newApp.id as number;

      // job_candidates
      try {
        const jobId = await ensureBaeminSystemJob(supabase);
        const isWeekend = String(newApp.work_hours ?? "").includes("주말");
        await supabase.from("job_candidates").insert({
          job_id: jobId,
          applicant_id: applicantId,
          agent_stage: "screening",
          agent_state: {
            screening: {
              프로모션_종료가능성_안내: true,
              정산주기_안내: true,
              업무시간_체계_이해: true,
              ...(isWeekend ? {} : { 공휴일_업무여부_확인: true }),
            },
            meta: { screening_entered_at: new Date().toISOString() },
          },
        });
      } catch (e) {
        console.error("[inbox/classify baemin] job_candidates create failed", e);
      }
    }

    // 동일 phone의 pending 메시지 일괄 처리 — classification='baemin' + applicant_id 연결
    await supabase
      .from("messages")
      .update({ classification: "baemin", applicant_id: applicantId })
      .eq("applicant_phone", phone)
      .eq("direction", "inbound")
      .eq("classification", "pending");

    // 활성 candidate 찾아 router 호출
    const { data: jc } = await supabase
      .from("job_candidates")
      .select("id, agent_stage")
      .eq("applicant_id", applicantId)
      .not("agent_stage", "is", null)
      .neq("agent_stage", "abort")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (jc?.id && jc.agent_stage !== "paused") {
      const agentResult = await runAgentForCandidate({
        supabase,
        candidate_id: jc.id as number,
        inbound_message_id: msg.id as string,
        inbound_text: body,
        received_at: msg.created_at as string,
      });
      return NextResponse.json({
        ok: true,
        action: "baemin",
        applicant_id: applicantId,
        agent_invoked: true,
        agent: agentResult,
      });
    }

    return NextResponse.json({
      ok: true,
      action: "baemin",
      applicant_id: applicantId,
      agent_invoked: false,
    });
  } catch (err) {
    console.error("[inbox/classify] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
