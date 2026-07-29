/**
 * POST /api/admin/inbox/[id]/classify
 *
 * body: { action: 'baemin' | 'job' | 'other' | 'ongmanaging', reason?: string, job_id?: number }
 *
 * - 'baemin': 배민 커넥트 자동 분류 shortcut. triage 파싱 → applicants(source='baemin')
 *             + ensureBaeminSystemJob + job_candidates(stage='screening') + router 호출.
 * - 'job'   : 매니저가 고른 실공고(라인)로 등록. applicants(source='inbound')
 *             + 그 job의 job_candidates(stage='screening') + current_job_id 결속 + router 호출.
 *             라인 형태(도시락 등 internal / 배민 external)는 스크리닝 스테이지가 recruit_mode로 분기.
 * - 'other' : classification='other'로만 마킹 (대상 메시지만)
 * - 'ongmanaging': 옹매니징(옹고잉 재직자·기존 계약자) 문의 이관.
 *             classification='ongmanaging' 마킹 + raw_payload에 이관 사유·시각 기록.
 *             새 applicant 생성/AI 발송 없음 ('other'와 동일하되 값·이관 기록으로 구분).
 * - 'undo'  : 되돌리기 — classification을 'pending'으로 복구해 목록에 다시 띄운다.
 *             **가역 분류(other·ongmanaging)만** 허용. baemin/job은 지원자 생성·초안까지 진행돼
 *             단순 마킹 해제로는 원복되지 않으므로 거부한다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { triageInbound } from "@/lib/agent/baemin-triage";
import { ensureBaeminSystemJob } from "@/lib/agent/baemin-job";
import { runAgentForCandidate } from "@/lib/agent/router";
import { isSystemJobTitle, isJobEffectivelyClosed } from "@/lib/jobs";
import { ensureExposureIncludeForLinked } from "@/lib/exposure";

export const dynamic = "force-dynamic";
// 등록 1건은 한 요청에서 Claude를 최대 2회(triage Haiku + 스크리닝 Sonnet) 부른다 — 플랫폼 기본
// 타임아웃(10~15초)에 걸리면 지원자·후보는 이미 생성됐는데 초안·스탬프가 없어 cron이 대신 답하는
// 최악의 조합이 된다. 같은 라우터를 쓰는 웹훅(maxDuration=90)과 같은 기준으로 늘린다.
export const maxDuration = 90;

// 등록 시 자동발송 억제를 '지속'시키는 스탬프.
//   문자함 등록은 AI 첫 응답을 초안까지만 만들고 발송은 매니저가 한다(forceDraft). 그런데 두 cron
//   (inbound-sweeper 10분 · agent-recovery 30분)은 항상 forceDraft 없이 라우터를 부르므로, 등록 턴이
//   흔적(초안 or meta.last_run_at)을 못 남기면 그 cron이 auto 모드로 대신 답해 시니어에게 검수 없는
//   문자가 나간다.
//   ★ 라우터 '앞에서' 찍는다 — 뒤에서 찍으면 함수 타임아웃·예외로 요청이 죽을 때 아무 흔적이 없어
//     게이트가 통째로 열린다. 앞에서 찍으면 그 뒤 라우터가 정상 진행해 더 최신 값으로 덮어쓰므로 손실 없다
//     (failResult 경로도 router가 DB state와 병합해 저장하므로 이 스탬프가 유지된다).
//   대상은 '활성 단계 최신 1건'만 — 지원자의 다른 공고 후보까지 찍으면 무관한 라인의 48h 정체 백스톱
//   시계를 리셋해버린다. 이 후보가 그 턴에 paused/abort로 빠져 sweeper가 '다른 활성 후보'를 고르는
//   경우는 sweeper 쪽 가드(d)가 지원자의 모든 후보 중 최신 실행 시각으로 판정해 함께 막는다.
//   sweeper 가드: meta.last_run_at >= 인바운드 created_at 이면 스킵 → 등록 시각은 항상 그보다 늦다.
//   등록 이후 지원자가 새로 보낸 문자는 created_at이 더 늦어 정상적으로 AI가 응대한다(억제 아님).
const ACTIVE_AGENT_STAGES = ["exploration", "screening", "onboarding", "active"];
async function stampAgentRun(
  supabase: ReturnType<typeof createServiceClient>,
  applicantId: number
): Promise<void> {
  try {
    const { data: cands, error: selErr } = await supabase
      .from("job_candidates")
      .select("id, agent_state")
      .eq("applicant_id", applicantId)
      .in("agent_stage", ACTIVE_AGENT_STAGES)
      .order("created_at", { ascending: false })
      .limit(1);
    if (selErr) {
      console.error("[inbox/classify] agent run stamp select failed", selErr);
      return;
    }
    const c = cands?.[0];
    if (!c) return;
    const state = (c.agent_state ?? {}) as Record<string, unknown>;
    const meta = (state.meta ?? {}) as Record<string, unknown>;
    const { error: updErr } = await supabase
      .from("job_candidates")
      .update({ agent_state: { ...state, meta: { ...meta, last_run_at: new Date().toISOString() } } })
      .eq("id", c.id as number);
    if (updErr) console.error("[inbox/classify] agent run stamp update failed", updErr);
  } catch (e) {
    console.error("[inbox/classify] agent run stamp failed", e);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { action, reason, job_id } = (await req.json()) as {
      action?: "baemin" | "job" | "other" | "ongmanaging" | "undo";
      reason?: string;
      job_id?: number;
    };
    if (action !== "baemin" && action !== "job" && action !== "other" && action !== "ongmanaging" && action !== "undo") {
      return NextResponse.json(
        { error: "action: 'baemin', 'job', 'other', 'ongmanaging' or 'undo'" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();
    const { data: msg, error: msgErr } = await supabase
      .from("messages")
      .select("id, applicant_phone, body, created_at, raw_payload, classification")
      .eq("id", params.id)
      .single();
    if (msgErr || !msg) {
      return NextResponse.json({ error: "message not found" }, { status: 404 });
    }
    // 되돌리기 — 아래 '이미 분류됨' 가드보다 먼저 처리해야 한다(되돌릴 대상이 곧 분류된 문자).
    if (action === "undo") {
      if (msg.classification !== "other" && msg.classification !== "ongmanaging") {
        return NextResponse.json(
          { error: "기타·옹매니징으로 분류한 문자만 되돌릴 수 있어요. (지원자로 등록한 건은 지원자 상세에서 처리하세요)" },
          { status: 400 }
        );
      }
      await supabase.from("messages").update({ classification: "pending" }).eq("id", msg.id);
      return NextResponse.json({ ok: true, action: "undo" });
    }

    // 이미 분류된 문자는 재분류하지 않는다 — 같은 번호의 형제 문자가 목록에 남아 있을 때(유령 카드)
    // 다시 누르면 지원자·후보가 또 만들어지고 AI 응답이 중복 발송되던 문제 방어.
    if (msg.classification !== "pending") {
      return NextResponse.json({ ok: true, action, noop: true, reason: "already_classified" });
    }

    if (action === "other") {
      await supabase
        .from("messages")
        .update({ classification: "other" })
        .eq("id", msg.id);
      return NextResponse.json({ ok: true, action: "other" });
    }

    if (action === "ongmanaging") {
      // 옹매니징 이관: 새 applicant 생성·AI 발송 없이 값만 구분해 마킹.
      // messages에 메모 컬럼이 없어 이관 사유·시각은 raw_payload(제약 없는 jsonb)에 기록.
      const prev =
        msg.raw_payload && typeof msg.raw_payload === "object"
          ? (msg.raw_payload as Record<string, unknown>)
          : {};
      const trimmedReason = typeof reason === "string" ? reason.trim() : "";
      await supabase
        .from("messages")
        .update({
          classification: "ongmanaging",
          raw_payload: {
            ...prev,
            ongmanaging_transfer: {
              note: `기존 계약자 문의 분류 — ${trimmedReason || "옹고잉 재직자·기존 계약자 문의"}`,
              transferred_at: new Date().toISOString(),
            },
          },
        })
        .eq("id", msg.id);
      return NextResponse.json({ ok: true, action: "ongmanaging" });
    }

    // action === 'job' — 매니저가 고른 실공고(라인)로 등록.
    if (action === "job") {
      const jobId = Number(job_id);
      if (!Number.isFinite(jobId)) {
        return NextResponse.json({ error: "job 등록에는 job_id가 필요합니다." }, { status: 400 });
      }
      const { data: job } = await supabase
        .from("jobs")
        .select("id, title, status, closes_at")
        .eq("id", jobId)
        .maybeSingle();
      if (!job || isSystemJobTitle(job.title as string) || isJobEffectivelyClosed(job.status as string | null, job.closes_at as string | null)) {
        return NextResponse.json({ error: "진행 중인 실공고만 선택할 수 있어요." }, { status: 400 });
      }

      const phone = msg.applicant_phone as string;
      const body = msg.body as string;

      // 기존 applicant 재사용 or 생성(파싱은 라인 무관 추출 재사용, source='inbound')
      const { data: existing } = await supabase
        .from("applicants").select("id").eq("phone", phone)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      let appId: number | null = existing?.id ?? null;
      if (!appId) {
        const tri = await triageInbound({ phone, body });
        const ext = tri.extracted;
        const PH = "미확인";
        const { data: newApp, error: appErr } = await supabase
          .from("applicants")
          .insert({
            name: ext.name?.trim() || "(이름 미확인)", phone,
            birth_date: PH, location: PH, own_vehicle: PH, license_type: PH,
            vehicle_type: ext.vehicle?.trim() || PH, branch1: PH, branch: PH,
            work_hours: ext.time_raw?.trim() || PH, available_date: PH, self_ownership: PH,
            source: "inbound", status: "스크리닝 중", filter_pass: null,
            introduction: ext.experience?.trim() || null,
            note: `매니저 수동 분류 (공고 #${jobId} 등록)`,
          })
          .select("id").single();
        if (appErr || !newApp) {
          console.error("[inbox/classify job] applicant create error", appErr);
          return NextResponse.json({ error: "applicant 생성 실패" }, { status: 500 });
        }
        appId = newApp.id as number;
      }

      // 그 공고 후보로 편입(중복이면 유지) + current_job_id 결속. 스크리닝 auto-true는 스테이지가 처리.
      const { data: jc } = await supabase
        .from("job_candidates")
        .upsert({ job_id: jobId, applicant_id: appId, agent_stage: "screening", sent_at: new Date().toISOString() }, { onConflict: "job_id,applicant_id" })
        .select("id").single();
      await supabase.from("applicants").update({ current_job_id: jobId }).eq("id", appId);
      // 지정 노출 공고면 이 분을 노출 명단에 남긴다 — 노출 판정은 후보 여부를 보지 않아서,
      // 명단에 없으면 AI는 이 공고를 응대하는데 본인 링크에는 그 공고가 없는 상태가 된다.
      // (실패해도 분류·응대는 계속한다 — 매니저가 파이프라인에서 명단에 추가할 수 있다.)
      try {
        await ensureExposureIncludeForLinked(supabase, jobId, [appId]);
      } catch (e) {
        console.error("[inbox/classify job] exposure include failed", e);
      }
      // 인입 문자 ↔ 지원자·공고 링크. AI 호출보다 **먼저** 하고 에러를 확인한다 —
      // 이 링크가 없으면 실시간 응대 목록의 '초안 검토' 신호가 뜨지 않아(미리보기가 messages.applicant_id
      // 기준) 초안만 만들고 매니저가 못 찾는 무응답 방치가 된다. 실패 시 Claude 과금 전에 끊는다.
      const { error: markErr } = await supabase
        .from("messages")
        .update({ classification: "matched", applicant_id: appId, job_id: jobId })
        .eq("applicant_phone", phone).eq("direction", "inbound").eq("classification", "pending");
      if (markErr) {
        console.error("[inbox/classify job] message link failed", markErr);
        return NextResponse.json(
          { error: `인입 문자를 지원자와 연결하지 못했어요: ${markErr.message}` },
          { status: 500 }
        );
      }

      // AI 호출 '전에' 찍는다 — 타임아웃·예외로 요청이 죽어도 cron이 auto로 대신 답하지 못하게.
      await stampAgentRun(supabase, appId);
      let agent = null;
      if (jc?.id) {
        agent = await runAgentForCandidate({
          supabase, candidate_id: jc.id as number,
          inbound_message_id: msg.id as string, inbound_text: body,
          received_at: msg.created_at as string,
          // 등록 순간 시니어에게 문자가 자동으로 나가지 않게 초안까지만 — 매니저가 대화에서 검수 후 발송.
          forceDraft: true,
        });
      }
      return NextResponse.json({ ok: true, action: "job", applicant_id: appId, job_id: jobId, agent_invoked: !!jc?.id, agent, draft_created: !!agent?.draft_created, handed_off: !!agent?.handed_off });
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

    // AI 호출 '전에' 찍는다(라우터를 안 태우는 경로도 함께 커버) — 요청이 죽어도 cron 재실행 차단.
    await stampAgentRun(supabase, applicantId);
    if (jc?.id && jc.agent_stage !== "paused") {
      const agentResult = await runAgentForCandidate({
        supabase,
        candidate_id: jc.id as number,
        inbound_message_id: msg.id as string,
        inbound_text: body,
        received_at: msg.created_at as string,
        // 등록 순간 시니어에게 문자가 자동으로 나가지 않게 초안까지만 — 매니저가 대화에서 검수 후 발송.
        forceDraft: true,
      });
      return NextResponse.json({
        ok: true,
        action: "baemin",
        applicant_id: applicantId,
        agent_invoked: true,
        agent: agentResult,
        draft_created: !!agentResult?.draft_created,
        handed_off: !!agentResult?.handed_off,
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
