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
import { classifyAvailabilitySignal } from "@/lib/agent/availability";
import { getAgentMode } from "@/lib/agent/kill-switch";
import { pickJobForCampaignReply } from "@/lib/agent/engage";
import { sendSms } from "@/lib/solapi";
import { sendSlackText } from "@/lib/slack";
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

    // 캠페인 답장자 편입(아래 4a-2)에서 쓰는 신호 — 가용성 분류가 끝난 뒤에만 판단한다.
    // recentPingAt: 최근 14일 내 ping_sent(캠페인 코호트 판정). inboundOptOut: 이번 인바운드가
    // '그만' 등 opt_out으로 분류됐는지(null=분류 자체가 안 됨 → 편입하지 않음, 보수적 폴백).
    let recentPingAt: string | null = null;
    let inboundOptOut: boolean | null = null;

    // 가용성 신호 수집 (Phase C) — 풀 응답(활성 후보 없음) 또는 최근 14일 내 ping 발송
    // 대상의 답장만 분류한다(비용 가드 §5.7). 실패해도 인입 처리는 깨지 않는다.
    try {
      const { data: recentPings } = await supabase
        .from("pool_events")
        .select("id, created_at")
        .eq("applicant_id", applicant.id)
        .eq("event_type", "ping_sent")
        .gte("created_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
        .order("created_at", { ascending: false })
        .limit(1);
      const lastPing = recentPings?.[0] ?? null;
      recentPingAt = (lastPing?.created_at as string | undefined) ?? null;

      if (!jc || lastPing) {
        // ping 응답 이벤트 — 응답률·응답속도(신뢰점수 §6.4-4) 재료
        if (lastPing) {
          const latencyMin = Math.max(
            0,
            Math.round(
              (new Date(receivedAt).getTime() - new Date(lastPing.created_at as string).getTime()) / 60_000
            )
          );
          await supabase.from("pool_events").insert({
            applicant_id: applicant.id,
            event_type: "ping_reply",
            meta: { message_id: String(msg.id), latency_minutes: latencyMin },
          });
        }

        const cls = await classifyAvailabilitySignal({ body: text });
        // 편입 가드용 opt-out 플래그 — DB 반영(confidence ≥ 0.6)보다 넓게, 신호만 있어도 편입은 막는다.
        inboundOptOut = cls.signal === "opt_out";
        if (cls.usage?.model) {
          await recordUsage(supabase, {
            model: cls.usage.model,
            purpose: "availability",
            usage: cls.usage,
          });
        }
        if (cls.signal !== "none" && cls.confidence >= 0.6) {
          const { data: cur } = await supabase
            .from("applicants")
            .select("availability, sms_opt_out_at")
            .eq("id", applicant.id)
            .single();
          const curRow = cur as { availability?: string | null; sms_opt_out_at?: string | null } | null;
          const from = (curRow?.availability ?? null) as string | null;
          // 강등 금지: '즉시가능'은 this_week 신호로 내려가지 않는다. 거절/수신거부만 휴면.
          const to =
            cls.signal === "immediate"
              ? "즉시가능"
              : cls.signal === "this_week"
                ? from === "즉시가능"
                  ? "즉시가능"
                  : "이번주가능"
                : "휴면";
          const patch: Record<string, unknown> = {
            availability: to,
            availability_updated_at: new Date().toISOString(),
          };
          // 수신거부 하드 플래그 — 휴면(소프트, 재컨택 복구 가능)과 별개의 컴플라이언스 상태.
          // 캠페인성 발송(벌크·디스패치)에서 영구 제외된다. 1:1 응대는 제한하지 않음.
          if (cls.signal === "opt_out" && !curRow?.sms_opt_out_at) {
            patch.sms_opt_out_at = new Date().toISOString();
          }
          await supabase.from("applicants").update(patch).eq("id", applicant.id);
          if (from !== to || cls.signal === "opt_out") {
            await supabase.from("pool_events").insert({
              applicant_id: applicant.id,
              event_type: "availability_set",
              meta: {
                from,
                to,
                source: "ping",
                confidence: cls.confidence,
                reasoning: cls.reasoning,
                opt_out: cls.signal === "opt_out",
              },
            });
          }
        }
      }
    } catch (e) {
      console.error("[supabase-webhook] availability signal collection failed", e);
    }

    // Agent 호출
    if (!jc || !jc.agent_stage) {
      // ── 4a-2) 캠페인 답장자 자동 편입 (auto 모드 한정) ──
      // 캠페인 문자에 링크 클릭 없이 '답장으로만' 반응한 지원자는 활성 후보가 없어 기존엔
      // 여기서 종료 → 무응답 사각지대(실사고 2026-07-10 김문규 "차량이없어요" 3일 방치).
      // auto 모드에서는 공고를 골라 screening 후보로 편입하고 이 인바운드를 그대로 라우터에
      // 넘긴다 — 별도 인트로 문자 없이 자연스러운 회신이 곧 스크리닝 시작.
      // draft/off 모드는 기존 경로 유지(초안 웹훅·매니저 수동 처리가 담당).
      // 어떤 실패도 non-fatal — 아래 기존 응답(no active job_candidate)으로 폴백한다.
      // 야간에도 발송함 — 방금 온 답장에 대한 즉시 회신은 기존 활성 후보 응대와 동일 원칙.
      try {
        const mode = await getAgentMode(supabase);
        // 편입 조건: auto 모드 + 최근 14일 내 ping_sent(캠페인 코호트) + 이번 인바운드가
        // opt-out으로 분류되지 않았음(inboundOptOut === false — 분류는 위 가용성 블록에서 이미 끝남).
        if (mode === "auto" && recentPingAt && inboundOptOut === false) {
          // 최신 상태 재조회 — 위 가용성 블록이 방금 sms_opt_out_at을 기록했을 수 있다.
          const { data: aRow } = await supabase
            .from("applicants")
            .select("status, sms_opt_out_at, current_job_id, lat, lng")
            .eq("id", applicant.id)
            .maybeSingle();
          const a = aRow as {
            status: string | null;
            sms_opt_out_at: string | null;
            current_job_id: number | null;
            lat: number | null;
            lng: number | null;
          } | null;
          const blockedStatus = a?.status === "부적합" || a?.status === "이탈";
          if (a && !a.sms_opt_out_at && !blockedStatus) {
            const pick = await pickJobForCampaignReply(supabase, {
              id: applicant.id,
              lat: a.lat,
              lng: a.lng,
            });
            // 정책: 한 사람 = 하나의 '진행 중' 공고 (engage·dispatch와 동일)
            const jobConflict =
              pick != null && a.current_job_id != null && a.current_job_id !== pick.jobId;
            if (pick && !jobConflict) {
              const { data: upserted, error: upErr } = await supabase
                .from("job_candidates")
                .upsert(
                  {
                    job_id: pick.jobId,
                    applicant_id: applicant.id,
                    agent_stage: "screening",
                    sent_at: new Date().toISOString(),
                    responded_at: receivedAt, // 이 인바운드가 곧 첫 응답
                  },
                  { onConflict: "job_id,applicant_id" }
                )
                .select("id")
                .single();
              if (upErr || !upserted) {
                console.error("[supabase-webhook] campaign-reply jc upsert failed", upErr);
              } else {
                const candidateId = (upserted as { id: number }).id;
                // engage와 동일 축 — current_job_id·인바운드 메시지 job_id 연결 (둘 다 non-fatal)
                const { error: cjErr } = await supabase
                  .from("applicants")
                  .update({ current_job_id: pick.jobId })
                  .eq("id", applicant.id);
                if (cjErr) console.error("[supabase-webhook] campaign-reply current_job_id failed", cjErr);
                const { error: mjErr } = await supabase
                  .from("messages")
                  .update({ job_id: pick.jobId })
                  .eq("id", msg.id);
                if (mjErr) console.error("[supabase-webhook] campaign-reply msg job_id failed", mjErr);
                const { error: evErr } = await supabase.from("pool_events").insert({
                  applicant_id: applicant.id,
                  job_id: pick.jobId,
                  event_type: "auto_engage",
                  meta: {
                    source: "campaign-reply",
                    picked_by: pick.pickedBy,
                    message_id: String(msg.id),
                  },
                });
                if (evErr) console.error("[supabase-webhook] campaign-reply pool_events failed", evErr);
                await sendSlackText(
                  `💬 캠페인 답장 → #${pick.jobId} 공고 스크리닝 자동 편입: ${applicant.name?.trim() || phone}`
                );
                // 그 인바운드를 그대로 라우터로 — 대화 맥락을 보고 자연스럽게 회신(확정 뉘앙스 금지는 라우터 백스톱이 보장)
                const agentResult = await runAgentForCandidate({
                  supabase,
                  candidate_id: candidateId,
                  inbound_message_id: String(msg.id),
                  inbound_text: text,
                  received_at: receivedAt,
                });
                return NextResponse.json({
                  ok: true,
                  matched: true,
                  agent_invoked: true,
                  enrolled: "campaign-reply",
                  job_id: pick.jobId,
                  picked_by: pick.pickedBy,
                  agent: agentResult,
                });
              }
            }
          }
        }
      } catch (e) {
        console.error("[supabase-webhook] campaign-reply enroll failed (fallback to draft path)", e);
      }
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
