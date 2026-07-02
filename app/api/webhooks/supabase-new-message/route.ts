/**
 * POST /api/webhooks/supabase-new-message
 *
 * Supabase Database Webhook 진입점.
 * SMS Gateway가 messages 테이블에 직접 INSERT(REST API)하기 때문에 우리 /api/messages/inbound가
 * 호출되지 않는다. 그래서 Supabase가 INSERT 이벤트를 받아 이 라우트로 webhook을 쏘게 한다.
 *
 * 처리:
 *  1. Supabase Webhook payload 검증
 *  2. record.direction='inbound' + classification IS NULL이면 (idempotent guard)
 *  3. phone으로 applicants 매칭 시도
 *     a. 매칭됨 → 메시지에 applicant_id 채우고 router.runAgentForCandidate
 *     b. 매칭 안 됨 → 하드 필터 / Haiku triage 분기
 *        - hard spam → classification='other'
 *        - is_baemin + conf ≥ 0.7 → applicants 자동 생성 + job_candidates + router
 *        - 그 외 → classification='pending' (매니저 인박스로)
 *
 * 인증: 헤더 Authorization = `Bearer ${SUPABASE_WEBHOOK_SECRET}`
 *
 * Supabase Dashboard에서 다음 webhook 만들어야 함:
 *   Table: messages
 *   Events: INSERT
 *   HTTP method: POST
 *   URL: https://ong-boarding-pi.vercel.app/api/webhooks/supabase-new-message
 *   Headers: Authorization: Bearer <SUPABASE_WEBHOOK_SECRET 값>
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { runAgentForCandidate } from "@/lib/agent/router";
import { triageInbound, isHardSpam } from "@/lib/agent/baemin-triage";
import { sendSms } from "@/lib/solapi";
import { getSystemMessage, fillTemplate } from "@/lib/agent/system-messages";
import { recordUsage, toMessageTokens } from "@/lib/agent/usage";

// (참고) baemin은 폼 작성 후에 job_candidates를 생성하므로 ensureBaeminSystemJob을 여기서 호출 안 함.

export const dynamic = "force-dynamic";
// router는 응답 텀(최대 45s) + AI + 발송으로 60s 가까이 가니 충분히 잡아둠
export const maxDuration = 90;

interface SupabaseWebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

interface MessageRecord {
  id: string | number;
  applicant_id: number | null;
  applicant_phone: string;
  direction: string;
  body: string;
  classification: string | null;
  created_at: string;
  job_id: number | null;
}

export async function POST(req: NextRequest) {
  // 1) 인증
  const expected = process.env.SUPABASE_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[supabase-webhook] SUPABASE_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 2) Payload 파싱
  let payload: SupabaseWebhookPayload;
  try {
    payload = (await req.json()) as SupabaseWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (payload.type !== "INSERT" || payload.table !== "messages" || !payload.record) {
    return NextResponse.json({ ok: true, skipped: "not a messages INSERT" });
  }
  const msg = payload.record as unknown as MessageRecord;
  if (msg.direction !== "inbound") {
    return NextResponse.json({ ok: true, skipped: "not inbound" });
  }
  // 이미 분류된 행이면 멱등 종료
  if (msg.classification) {
    return NextResponse.json({ ok: true, skipped: "already classified" });
  }

  const supabase = createServiceClient();

  // 멱등 클레임 — 이 inbound 메시지를 정확히 한 번만 처리한다.
  // Supabase 웹훅은 at-least-once(재전송)라, 매칭 지원자 경로(classification 미기재)도 이 가드로 보호.
  // webhook_processed_at을 원자적으로 선점(0건이면 이미 처리됨 → skip).
  {
    const { data: claimed, error: claimErr } = await supabase
      .from("messages")
      .update({ webhook_processed_at: new Date().toISOString() })
      .eq("id", msg.id)
      .is("webhook_processed_at", null)
      .select("id");
    if (claimErr) {
      // 컬럼 미존재 등으로 클레임 실패 시 인바운드 전면 장애를 피하려 fail-open(계속 진행).
      // 마이그레이션(2026-07-messages-webhook-idempotency.sql) 적용 후 정상 멱등 동작.
      console.error("[supabase-webhook] idempotency claim failed (proceeding)", claimErr);
    } else if (!claimed || claimed.length === 0) {
      return NextResponse.json({ ok: true, skipped: "already processed (webhook re-delivery)" });
    }
  }

  const phone = String(msg.applicant_phone || "").replace(/[^\d]/g, "");
  const text = String(msg.body || "").trim();
  const receivedAt = msg.created_at;

  // 3) phone으로 기존 applicant 매칭 시도
  let applicant: { id: number; name: string | null } | null = null;
  if (msg.applicant_id) {
    const { data } = await supabase
      .from("applicants")
      .select("id, name")
      .eq("id", msg.applicant_id)
      .maybeSingle();
    applicant = (data as { id: number; name: string | null } | null) ?? null;
  } else {
    const { data: matched } = await supabase
      .from("applicants")
      .select("id, name")
      .eq("phone", phone)
      .order("created_at", { ascending: false })
      .limit(1);
    applicant = (matched?.[0] as { id: number; name: string | null } | undefined) ?? null;
  }

  // ───────────────────────────────────────────────────────────────
  // 4a) 매칭됨 → message에 applicant_id 채우고 active candidate에 router 호출
  // ───────────────────────────────────────────────────────────────
  if (applicant) {
    // 활성 candidate 조회 (멀티-잡 대비 Phase 0)
    // 예전: 가장 최근 '생성된' 후보 1건만 선택 → 한 지원자가 여러 공고에 활성이면 엉뚱한 공고로 답할 위험.
    // 지금: 활성 후보를 모두 로드한 뒤 "마지막으로 대화한 공고(직전 outbound의 job_id)"를 우선 선택.
    //       (없으면 가장 최근 생성 후보로 폴백 → 단일 공고일 땐 기존과 동일 동작)
    type ActiveCand = { id: number; job_id: number | null; agent_stage: string | null; responded_at: string | null };
    const { data: activeCands } = await supabase
      .from("job_candidates")
      .select("id, job_id, agent_stage, responded_at, created_at")
      .eq("applicant_id", applicant.id)
      .not("agent_stage", "is", null)
      .neq("agent_stage", "abort")
      .order("created_at", { ascending: false });

    let jc: ActiveCand | null = null;
    const cands = (activeCands ?? []) as (ActiveCand & { created_at: string })[];
    if (cands.length === 1) {
      jc = cands[0];
    } else if (cands.length > 1) {
      // 직전 outbound 메시지의 job_id = "지금 대화 중인 공고"로 추정
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

    // message에 applicant_id (+ 가능하면 job_id) 채우기
    const msgUpdate: Record<string, unknown> = { applicant_id: applicant.id };
    if (jc?.job_id) msgUpdate.job_id = jc.job_id;
    await supabase.from("messages").update(msgUpdate).eq("id", msg.id);

    // 첫 응답이면 responded_at 기록
    if (jc && !jc.responded_at) {
      await supabase
        .from("job_candidates")
        .update({ responded_at: receivedAt })
        .eq("id", jc.id);
    }

    // 안 읽음 카운터 증가
    await supabase.rpc("increment_unread", { p_applicant_id: applicant.id }).then(
      () => {},
      async () => {
        const { data: a } = await supabase
          .from("applicants")
          .select("unread_count")
          .eq("id", applicant.id)
          .single();
        await supabase
          .from("applicants")
          .update({
            unread_count: ((a as { unread_count?: number } | null)?.unread_count ?? 0) + 1,
            last_message_at: receivedAt,
          })
          .eq("id", applicant.id);
      }
    );

    // Agent 호출
    if (!jc || !jc.agent_stage) {
      return NextResponse.json({
        ok: true,
        matched: true,
        agent_invoked: false,
        reason: "no active job_candidate",
      });
    }
    if (jc.agent_stage === "paused") {
      return NextResponse.json({
        ok: true,
        matched: true,
        agent_invoked: false,
        reason: "candidate paused — manager handles",
      });
    }
    const agentResult = await runAgentForCandidate({
      supabase,
      candidate_id: jc.id as number,
      inbound_message_id: String(msg.id),
      inbound_text: text,
      received_at: receivedAt,
    });
    return NextResponse.json({
      ok: true,
      matched: true,
      agent_invoked: true,
      agent: agentResult,
    });
  }

  // ───────────────────────────────────────────────────────────────
  // 4b) 매칭 안 됨 → 하드 필터 / triage
  // ───────────────────────────────────────────────────────────────
  if (isHardSpam(phone, text)) {
    await supabase.from("messages").update({ classification: "other" }).eq("id", msg.id);
    return NextResponse.json({
      ok: true,
      matched: false,
      classification: "other",
      reason: "hard-filter spam",
    });
  }

  const triage = await triageInbound({ phone, body: text });

  // Triage 사용량 적재 — ai_usage_daily + inbound 메시지 행에 토큰 컬럼 채우기.
  if (triage.usage?.model) {
    await recordUsage(supabase, {
      model: triage.usage.model,
      purpose: "triage",
      usage: triage.usage,
    });
    const tokenCols = toMessageTokens(triage.usage.model, triage.usage);
    await supabase
      .from("messages")
      .update({
        model: tokenCols.model,
        tokens_in: tokenCols.tokens_in,
        tokens_out: tokenCols.tokens_out,
        cache_read_tokens: tokenCols.cache_read_tokens,
      })
      .eq("id", msg.id);
  }

  const isAutoBaemin = triage.is_baemin && triage.confidence >= 0.7;

  if (isAutoBaemin) {
    const ext = triage.extracted;
    const PH = "미확인";

    // 1) 임시 baemin applicants 생성 (폼 작성 전이므로 status='스크리닝 전').
    //    job_candidates는 폼 제출 후 /api/apply 흐름에서 생성. 지금은 AI 응대 X.
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
        status: "스크리닝 전",
        filter_pass: null,
        introduction: ext.experience?.trim() || null,
        note: `자동 분류 (배민, conf ${triage.confidence.toFixed(2)}): ${triage.reasoning}`,
      })
      .select("id, name")
      .single();

    if (appErr || !newApplicant) {
      console.error("[supabase-webhook] baemin applicant create error", appErr);
      await supabase.from("messages").update({ classification: "pending" }).eq("id", msg.id);
      return NextResponse.json({
        ok: true,
        classification: "pending",
        reason: "applicant create failed",
        triage,
      });
    }
    const applicantId = (newApplicant as { id: number; name: string | null }).id;

    // 2) 메시지에 applicant_id + classification 채우기
    await supabase
      .from("messages")
      .update({
        applicant_id: applicantId,
        classification: "baemin",
      })
      .eq("id", msg.id);

    // 3) 지원자에게 apply 폼 URL을 SMS로 안내. system_message 'baemin_apply_invite' 본문 사용,
    //    없으면 fallback. {{이름}}/{{지원폼주소}} placeholder 치환.
    const baseUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      "https://ong-boarding-pi.vercel.app";
    const normalizedBase = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
    const applyUrl = `${normalizedBase}/apply?source=baemin`;
    const nameForFill = ext.name?.trim() ? ` ${ext.name.trim()}` : "";

    const stored = (await getSystemMessage(supabase, "baemin_apply_invite"))?.trim();
    const fallback = [
      `안녕하세요${nameForFill}님, 옹고잉 배송원 지원 감사드립니다!`,
      "",
      "정식 지원을 위해 아래 폼 작성을 부탁드릴게요^^",
      applyUrl,
      "",
      "작성 완료되시면 영업일 기준 1~2일 내 안내드리겠습니다.",
    ].join("\n");
    const sendBody = stored
      ? fillTemplate(stored, { 이름: nameForFill, 지원폼주소: applyUrl })
      : fallback;

    let inviteMessageId: string | null = null;
    try {
      const r = await sendSms(phone, sendBody);
      inviteMessageId = r.messageId ?? null;
      if (!r.success) {
        console.error("[supabase-webhook] baemin apply invite SMS fail", r.error);
      }
    } catch (e) {
      console.error("[supabase-webhook] baemin apply invite SMS exception", e);
    }

    // 4) outbound messages 기록
    await supabase.from("messages").insert({
      applicant_id: applicantId,
      applicant_phone: phone,
      direction: "outbound",
      body: sendBody,
      status: "sent",
      sent_by: "system-baemin-invite",
      solapi_msg_id: inviteMessageId,
      message_type: "sms",
    });

    return NextResponse.json({
      ok: true,
      classification: "baemin",
      applicant_id: applicantId,
      triage,
      apply_url_sent: true,
      agent_invoked: false,
    });
  }

  // 자신 없음 → pending (매니저 인박스)
  await supabase.from("messages").update({ classification: "pending" }).eq("id", msg.id);
  return NextResponse.json({
    ok: true,
    classification: "pending",
    triage,
  });
}
