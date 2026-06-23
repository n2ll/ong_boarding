/**
 * POST /api/messages/inbound
 *
 * SMS Gateway(전용 폰) → 본 라우트가 인입의 단일 진입점.
 *
 * 흐름:
 *   1) 인증 (헤더 시크릿)
 *   2) phone으로 applicant 매칭
 *   3) messages INSERT (direction=inbound, job_id=현재 진행중 공고)
 *   4) applicants.unread_count++, last_message_at 갱신
 *   5) job_candidates.responded_at 갱신 (첫 응답이면)
 *   6) agent_stage 분기:
 *        - screening/onboarding/active → router.runAgentForCandidate()
 *        - paused/abort/null → 에이전트 호출 없이 종료 (매니저 직접 응대)
 *
 * 멱등성: (applicant_phone, body, received_at) 기반 best-effort 중복 차단.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { runAgentForCandidate } from "@/lib/agent/router";
import { triageInbound, isHardSpam } from "@/lib/agent/baemin-triage";
import { ensureBaeminSystemJob } from "@/lib/agent/baemin-job";

export const dynamic = "force-dynamic";
// 답장 텀(최대 45s 슬립) + AI(~5~10s) + 발송 — 60s 안에 마치도록 maxDuration 60.
// (Vercel Hobby 한도 = 60s. Pro면 더 늘려도 무방.)
export const maxDuration = 60;

interface InboundPayload {
  from: string;            // 발신 번호 ("010-1234-5678" 또는 "01012345678")
  text: string;            // SMS 본문
  received_at?: string;    // 가능하면 ISO8601, 없으면 서버 now()
  device_id?: string;      // 전용 폰 식별자
  external_id?: string;    // Gateway가 부여한 고유 ID (멱등성)
}

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

export async function POST(req: NextRequest) {
  // 1) 인증
  const expected = process.env.INBOUND_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[inbound] INBOUND_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }
  const provided = req.headers.get("x-webhook-secret");
  if (provided !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: InboundPayload;
  try {
    payload = (await req.json()) as InboundPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!payload.from || !payload.text) {
    return NextResponse.json({ error: "from, text 필수" }, { status: 400 });
  }

  const phone = normalizePhone(payload.from);
  const text = payload.text.trim();
  const supabase = createServiceClient();
  const receivedAt = payload.received_at || new Date().toISOString();

  // 2) applicant 매칭 (phone 일치, 가장 최근 1명)
  const { data: applicants } = await supabase
    .from("applicants")
    .select("id, current_job_id, name, status")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(1);
  const applicant = applicants?.[0] ?? null;

  // 3) 멱등성 — external_id 있으면 messages.solapi_msg_id 자리에 stash
  if (payload.external_id) {
    const { data: dup } = await supabase
      .from("messages")
      .select("id")
      .eq("solapi_msg_id", payload.external_id)
      .eq("direction", "inbound")
      .maybeSingle();
    if (dup) {
      return NextResponse.json({ ok: true, dedup: true });
    }
  }

  // 3.5) 알려지지 않은 phone — 하드 필터 + Haiku triage → 자동 baemin 생성 또는 pending 인박스
  if (!applicant) {
    // 하드 필터: 명백한 스팸은 즉시 'other'
    if (isHardSpam(phone, text)) {
      const { data: insOther } = await supabase
        .from("messages")
        .insert({
          applicant_phone: phone,
          direction: "inbound",
          body: text,
          status: "received",
          sent_by: payload.device_id ?? "sms-gateway",
          solapi_msg_id: payload.external_id ?? null,
          message_type: "sms",
          created_at: receivedAt,
          classification: "other",
        })
        .select("id")
        .single();
      return NextResponse.json({
        ok: true,
        message_id: insOther?.id,
        classification: "other",
        reason: "hard-filter spam",
      });
    }

    // Haiku triage
    const triage = await triageInbound({ phone, body: text });
    const isAutoBaemin = triage.is_baemin && triage.confidence >= 0.7;

    if (isAutoBaemin) {
      // 자동 baemin 후보 생성 (extracted 필드 prefill, 미확인 컬럼은 PLACEHOLDER)
      const ext = triage.extracted;
      const PH = "미확인";
      const { data: newApplicant, error: appErr } = await supabase
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
          note: `자동 분류 (배민, conf ${triage.confidence.toFixed(2)}): ${triage.reasoning}`,
        })
        .select("*")
        .single();

      if (appErr || !newApplicant) {
        console.error("[inbound] baemin auto applicant create error", appErr);
        const { data: insFb } = await supabase
          .from("messages")
          .insert({
            applicant_phone: phone,
            direction: "inbound",
            body: text,
            status: "received",
            sent_by: payload.device_id ?? "sms-gateway",
            solapi_msg_id: payload.external_id ?? null,
            message_type: "sms",
            created_at: receivedAt,
            classification: "pending",
          })
          .select("id")
          .single();
        return NextResponse.json({
          ok: true,
          message_id: insFb?.id,
          classification: "pending",
          reason: "applicant create failed",
          triage,
        });
      }

      let jobIdForBaemin: number | null = null;
      let candidateIdForBaemin: number | null = null;
      try {
        jobIdForBaemin = await ensureBaeminSystemJob(supabase);
        const isWeekend = String(newApplicant.work_hours ?? "").includes("주말");
        // agent_stage는 항상 'screening' 시작 — UI에 단계가 정상적으로 보이도록.
        // AI 응답 차단은 router 안의 kill switch 가드가 담당.
        const { data: jcIns } = await supabase
          .from("job_candidates")
          .insert({
            job_id: jobIdForBaemin,
            applicant_id: newApplicant.id,
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
          })
          .select("id")
          .single();
        candidateIdForBaemin = (jcIns?.id as number) ?? null;
      } catch (e) {
        console.error("[inbound] baemin job_candidates create failed", e);
      }

      const { data: msgB } = await supabase
        .from("messages")
        .insert({
          applicant_id: newApplicant.id,
          applicant_phone: phone,
          direction: "inbound",
          body: text,
          status: "received",
          sent_by: payload.device_id ?? "sms-gateway",
          solapi_msg_id: payload.external_id ?? null,
          message_type: "sms",
          job_id: jobIdForBaemin,
          created_at: receivedAt,
          classification: "baemin",
        })
        .select("id")
        .single();

      if (msgB?.id && candidateIdForBaemin != null) {
        const agentResult = await runAgentForCandidate({
          supabase,
          candidate_id: candidateIdForBaemin,
          inbound_message_id: msgB.id,
          inbound_text: text,
          received_at: receivedAt,
        });
        return NextResponse.json({
          ok: true,
          message_id: msgB.id,
          classification: "baemin",
          applicant_id: newApplicant.id,
          triage,
          agent_invoked: true,
          agent: agentResult,
        });
      }

      return NextResponse.json({
        ok: true,
        message_id: msgB?.id,
        classification: "baemin",
        applicant_id: newApplicant.id,
        triage,
        agent_invoked: false,
      });
    }

    // 자신 없음 → pending (매니저 인박스)
    const { data: insPending } = await supabase
      .from("messages")
      .insert({
        applicant_phone: phone,
        direction: "inbound",
        body: text,
        status: "received",
        sent_by: payload.device_id ?? "sms-gateway",
        solapi_msg_id: payload.external_id ?? null,
        message_type: "sms",
        created_at: receivedAt,
        classification: "pending",
      })
      .select("id")
      .single();
    return NextResponse.json({
      ok: true,
      message_id: insPending?.id,
      classification: "pending",
      triage,
    });
  }

  // 진행 중인 job 확인 (active job_candidate 우선)
  let activeJobId: number | null = null;
  let candidateRow: { id: number; agent_stage: string | null } | null = null;
  if (applicant) {
    // 멀티-잡 대비 Phase 0: 활성 후보를 모두 로드한 뒤 "마지막으로 대화한 공고"를 우선 선택.
    // (단일 공고일 땐 기존과 동일. webhooks/supabase-new-message 와 동일한 라우팅 정책)
    type ActiveCand = { id: number; job_id: number | null; agent_stage: string | null; responded_at: string | null };
    const { data: activeCands } = await supabase
      .from("job_candidates")
      .select("id, job_id, agent_stage, responded_at, created_at")
      .eq("applicant_id", applicant.id)
      .not("agent_stage", "is", null)
      .neq("agent_stage", "abort")
      .order("created_at", { ascending: false });

    const cands = (activeCands ?? []) as (ActiveCand & { created_at: string })[];
    let jc: ActiveCand | null = null;
    if (cands.length === 1) {
      jc = cands[0];
    } else if (cands.length > 1) {
      const { data: lastOut } = await supabase
        .from("messages")
        .select("job_id")
        .eq("applicant_id", applicant.id)
        .eq("direction", "outbound")
        .not("job_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastJobId = (lastOut?.job_id as number | null) ?? null;
      jc =
        (lastJobId != null ? cands.find((c) => c.job_id === lastJobId) : undefined) ??
        cands[0];
      console.warn(
        `[inbound] applicant ${applicant.id}: ${cands.length}개 공고 동시 진행 — job ${jc.job_id}로 라우팅 (직전 대화 공고: ${lastJobId ?? "없음"})`
      );
    }
    if (jc) {
      activeJobId = jc.job_id as number;
      candidateRow = { id: jc.id as number, agent_stage: jc.agent_stage as string | null };
      // 첫 응답이면 responded_at 기록
      if (!jc.responded_at) {
        await supabase
          .from("job_candidates")
          .update({ responded_at: receivedAt })
          .eq("id", jc.id);
      }
    }
  }

  // 4) messages INSERT
  const { data: inserted, error: insertErr } = await supabase
    .from("messages")
    .insert({
      applicant_id: applicant?.id ?? null,
      applicant_phone: phone,
      direction: "inbound",
      body: text,
      status: "received",
      sent_by: payload.device_id ?? "sms-gateway",
      solapi_msg_id: payload.external_id ?? null,
      message_type: "sms",
      job_id: activeJobId,
      created_at: receivedAt,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    console.error("[inbound] messages insert", insertErr);
    return NextResponse.json({ error: "메시지 저장 실패" }, { status: 500 });
  }

  // 5) applicants 카운터
  if (applicant) {
    await supabase.rpc("increment_unread", { p_applicant_id: applicant.id }).then(
      () => {},
      async () => {
        // RPC 없으면 폴백: 직접 UPDATE
        const { data: a } = await supabase
          .from("applicants")
          .select("unread_count")
          .eq("id", applicant.id)
          .single();
        await supabase
          .from("applicants")
          .update({
            unread_count: (a?.unread_count ?? 0) + 1,
            last_message_at: receivedAt,
          })
          .eq("id", applicant.id);
      }
    );
  }

  // 6) Agent 호출
  if (!candidateRow || !candidateRow.agent_stage) {
    return NextResponse.json({
      ok: true,
      message_id: inserted.id,
      agent_invoked: false,
      reason: applicant ? "no active job_candidate" : "unknown applicant",
    });
  }

  if (candidateRow.agent_stage === "paused") {
    return NextResponse.json({
      ok: true,
      message_id: inserted.id,
      agent_invoked: false,
      reason: "candidate paused — manager handles",
    });
  }

  // 매니저가 '부적합' 또는 '이탈'로 처리한 지원자에게는 AI가 일체 응답하지 않는다.
  // - 부적합: 정책/법적 항의로 탈락 처리된 케이스
  // - 이탈: 확정·근무 후 그만둔 케이스 (퇴사자에게 AI가 안내문자 보내면 안 됨)
  if (applicant?.status === "부적합" || applicant?.status === "이탈") {
    return NextResponse.json({
      ok: true,
      message_id: inserted.id,
      agent_invoked: false,
      reason: `applicant marked ${applicant.status} — agent silenced`,
    });
  }

  const agentResult = await runAgentForCandidate({
    supabase,
    candidate_id: candidateRow.id,
    inbound_message_id: inserted.id,
    inbound_text: text,
    received_at: receivedAt, // 인입 시각 기준 답장 텀 적용 (router에서 대기)
  });

  return NextResponse.json({
    ok: true,
    message_id: inserted.id,
    agent_invoked: true,
    agent: agentResult,
  });
}
