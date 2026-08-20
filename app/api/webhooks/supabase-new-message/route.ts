/**
 * POST /api/webhooks/supabase-new-message
 *
 * Supabase Database Webhook 진입점.
 * SMS Gateway가 messages 테이블에 직접 INSERT(REST API)하기 때문에 우리 /api/messages/inbound가
 * 호출되지 않는다. 그래서 Supabase가 INSERT 이벤트를 받아 이 라우트로 webhook을 쏘게 한다.
 *
 * 처리:
 *  1. Supabase Webhook payload 검증 → 멱등 클레임까지 동기 처리 후 **즉시 200 ACK**
 *     (발사원 pg_net은 10초 상한·재시도 없음 — 본처리는 waitUntil 백그라운드로.
 *      2026-07-13 배포 직후 콜드 스타트 유실 RCA의 원인 제거)
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
import { waitUntil } from "@vercel/functions";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase";
import { runAgentForCandidate } from "@/lib/agent/router";
import { triageInbound, isHardSpam } from "@/lib/agent/baemin-triage";
import { classifyAvailabilitySignal } from "@/lib/agent/availability";
import { getAgentMode } from "@/lib/agent/kill-switch";
import { pickJobForCampaignReply } from "@/lib/agent/engage";
import { pickCandidateForInbound, handleAmbiguousInbound, describeRoute } from "@/lib/agent/inbound-routing";
import { sendSms } from "@/lib/solapi";
import { sendSlackText } from "@/lib/slack";
import { getSystemMessage, fillTemplate } from "@/lib/agent/system-messages";
import { resolveAutomatedOutboundText } from "@/lib/agent/outbound-safety";
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

  // 3~4) 본처리는 백그라운드로 넘기고 즉시 200 ACK.
  // 발사원(Supabase pg_net 웹훅)은 10초 상한·1회 발사·재시도 없음인데, 본처리는 답장 텀
  // (60~75초)까지 응답을 잡고 있었다 → "클라이언트가 끊겨도 함수는 계속 돈다"는 비보장 동작에
  // 매 인입이 의존. 배포 직후 콜드 스타트와 겹치면 호출이 통째로 소멸(2026-07-13 송시권 QM6
  // 유실 RCA). waitUntil은 응답 후에도 완료를 플랫폼이 보장한다. 잔여 극단 케이스(핸들러 시작
  // 전 취소)는 inbound-sweeper cron이 회수.
  waitUntil(
    processInbound(supabase, msg)
      .then((r) => console.log("[supabase-webhook] processed", JSON.stringify(r)))
      .catch((e) => console.error("[supabase-webhook] background processing failed", e))
  );
  return NextResponse.json({ ok: true, accepted: true });
}

// 인입 본처리 — 기존 동기 처리 본문 그대로(반환값은 로그용). 실패해도 POST 응답과 무관.
async function processInbound(
  supabase: SupabaseClient,
  msg: MessageRecord
): Promise<Record<string, unknown>> {
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
    // 어느 공고 건인지는 **lib/agent/inbound-routing 한 곳**이 정한다(웹훅·sweeper·draft 공통).
    // 예전엔 이 세 경로가 각자 다른 기준을 써서, 같은 답장이 어느 경로로 잡히느냐에 따라 다른 공고로
    // 응대됐다. 앵커(직전 outbound)에서 **대량·캠페인 발송을 제외**하는 것도 여기서 처리한다 —
    // 안 하면 공고 7개를 동시에 발사할 때 모든 답장이 '마지막 발송 공고'로 몰린다.
    const route = await pickCandidateForInbound(supabase, applicant.id, text);
    const jc = route.ok ? route.candidate : null;
    // 판별 불가는 **고르지 않는다** — 되묻거나(자동 모드 1회) 매니저에게 넘긴다.
    // 다만 **처리는 아래 가용성 분류가 끝난 뒤에** 한다 — '그만 보내세요' 답장에 "어느 자리 말씀이세요?"
    // 문자가 나가면 안 된다(수신거부 판정은 그 블록에서 나온다).
    if (!route.ok && route.reason === "ambiguous") {
      console.warn(`[inbound] applicant ${applicant.id}: ${describeRoute(route)}`);
    }
    let ambiguousHandled: { asked: boolean; pausedCandidates: number } | null = null;

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

    // 안 읽음 카운터·last_message_at 은 DB 트리거가 한다 — 여기서 하지 않는다.
    //
    // messages 테이블의 `trg_match_applicant`(BEFORE INSERT)가 삽입 시점에
    // last_message_at 갱신과 inbound unread_count +1 을 이미 처리한다.
    // 삽입 경로가 이 웹훅만이 아니므로(수동 발송·캠페인·에이전트 응대) 테이블 쪽이 맞는 자리다.
    //
    // 예전에 여기 있던 코드는 이랬다:
    //   await supabase.rpc("increment_unread", …).then(() => {}, async () => { /* 폴백 */ });
    // 두 가지가 겹쳐 **아무 일도 하지 않는 코드**였다 —
    //   1) increment_unread 함수가 DB에 없다(pg_proc 0건).
    //   2) Supabase 쿼리 빌더는 실패해도 reject 하지 않고 { error } 로 resolve 하므로
    //      두 번째(실패) 콜백이 아예 불리지 않는다.
    // 이 죽은 코드 때문에 "이 컬럼은 갱신되지 않는다"고 잘못 읽고 트리거를 중복으로 붙였다가
    // unread_count 가 +2 되는 일이 있었다(2026-08-14, 즉시 되돌림).
    // 자세한 경위는 docs/migrations/2026-08-last-message-at-trigger.sql.

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

    // 판별 불가 처리 — 가용성 분류(수신거부 판정)가 끝난 지금 실행한다.
    if (!route.ok && route.reason === "ambiguous") {
      ambiguousHandled = await handleAmbiguousInbound(supabase, {
        applicantId: applicant.id,
        phone,
        applicantName: applicant.name,
        options: route.options,
        why: route.why,
        mode: await getAgentMode(supabase),
        inboundOptOut,
        sendSms: (to, body) => sendSms(to, body),
        notify: (t) => sendSlackText(t),
      });
    }
    // 판별 불가(되묻기·보류 처리 완료)는 여기서 끝낸다 — 아래 캠페인 자동 편입으로 내려가면
    // 방금 "어느 자리인지 모르겠다"고 판단한 답장을 근거로 **공고를 골라 편입**하게 된다.
    if (ambiguousHandled) {
      return {
        ok: true,
        matched: true,
        agent_invoked: false,
        reason: ambiguousHandled.asked
          ? "job ambiguous — asked once"
          : `job ambiguous — paused ${ambiguousHandled.pausedCandidates} candidate(s) for manager`,
      };
    }
    // 매니저가 들고 있는 대화(보류)만 있는 사람도 자동 편입 대상이 아니다 — 예전엔 보류 후보가
    // jc로 잡혀 이 블록을 그냥 지나갔다(라우팅 단일화로 jc가 null이 되면서 드러난 경로).
    if (!route.ok && route.reason === "paused") {
      return {
        ok: true,
        matched: true,
        agent_invoked: false,
        reason: "candidate paused — manager handles",
      };
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
          const blockedStatus = a?.status === "부적합" || a?.status === "이탈" || a?.status === "확정인력";
          if (a && !a.sms_opt_out_at && !blockedStatus) {
            const pick = await pickJobForCampaignReply(supabase, {
              id: applicant.id,
              lat: a.lat,
              lng: a.lng,
            });
            // 정책: 한 사람 = 하나의 '진행 중' 공고 (engage·dispatch와 동일)
            // 활성 공고가 여러 개라 '어느 공고 얘기인지' 확정할 수 없으면 자동 편입을 하지 않는다
            // (추측 편입 금지, lib/agent/engage.pickJobForCampaignReply ③). 문자는 이미 이 지원자 스레드에 붙어
            // '내가 답할 차례' 큐에 뜨지만, 자동 응대가 없다는 사실은 알려야 한다.
            // 활성 공고가 0개(보낼 공고 자체가 없음)일 때는 알리지 않는다 — 매니저가 할 일이 없다.
            // 단 '열린 공고는 있는데 전부 이분의 노출 명단 밖'은 다르다 — 공고를 명단으로 좁히면 생기는
            // 상태이고, 이때 알리지 않으면 일할 수 있다고 답장한 사람이 응대도 알림도 못 받는다.
            if (pick && pick.jobId === null) {
              const who = applicant.name?.trim() || phone;
              await sendSlackText(
                pick.exposureGateFailed
                  ? `⚠️ 캠페인 답장 — 노출 대상 판정을 못 해서(조회 실패) 열린 공고 ${pick.exposureBlockedCount}개 전부를 보류했어요: ${who} · 시스템 오류 가능성이 있으니 실시간 응대에서 직접 확인해 주세요`
                  : pick.exposureBlockedCount
                    ? `💬 캠페인 답장 — 열린 공고 ${pick.exposureBlockedCount}개가 모두 이분의 노출 대상(명단·규칙) 밖이라 자동 편입을 건너뜀: ${who} · 명단에 추가할지 / 직접 답할지 실시간 응대의 '내가 답할 차례'에서 확인해 주세요`
                    : `💬 캠페인 답장 — 열린 공고가 ${pick.ambiguousCount}개라 어느 공고인지 확정할 수 없어 자동 편입을 건너뜀: ${who} · 실시간 응대의 '내가 답할 차례'에서 직접 확인해 주세요`
              );
            }
            const picked = pick && pick.jobId !== null ? pick : null;
            const jobConflict =
              picked != null && a.current_job_id != null && a.current_job_id !== picked.jobId;
            if (picked && !jobConflict) {
              const { data: upserted, error: upErr } = await supabase
                .from("job_candidates")
                .upsert(
                  {
                    job_id: picked.jobId,
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
                  .update({ current_job_id: picked.jobId })
                  .eq("id", applicant.id);
                if (cjErr) console.error("[supabase-webhook] campaign-reply current_job_id failed", cjErr);
                const { error: mjErr } = await supabase
                  .from("messages")
                  .update({ job_id: picked.jobId })
                  .eq("id", msg.id);
                if (mjErr) console.error("[supabase-webhook] campaign-reply msg job_id failed", mjErr);
                const { error: evErr } = await supabase.from("pool_events").insert({
                  applicant_id: applicant.id,
                  job_id: picked.jobId,
                  event_type: "auto_engage",
                  meta: {
                    source: "campaign-reply",
                    picked_by: picked.pickedBy,
                    message_id: String(msg.id),
                  },
                });
                if (evErr) console.error("[supabase-webhook] campaign-reply pool_events failed", evErr);
                await sendSlackText(
                  `💬 캠페인 답장 → #${picked.jobId} 공고 스크리닝 자동 편입: ${applicant.name?.trim() || phone}`
                );
                // 그 인바운드를 그대로 라우터로 — 대화 맥락을 보고 자연스럽게 회신(확정 뉘앙스 금지는 라우터 백스톱이 보장)
                const agentResult = await runAgentForCandidate({
                  supabase,
                  candidate_id: candidateId,
                  inbound_message_id: String(msg.id),
                  inbound_text: text,
                  received_at: receivedAt,
                });
                return {
                  ok: true,
                  matched: true,
                  agent_invoked: true,
                  enrolled: "campaign-reply",
                  job_id: picked.jobId,
                  picked_by: picked.pickedBy,
                  agent: agentResult,
                };
              }
            }
          }
        }
      } catch (e) {
        console.error("[supabase-webhook] campaign-reply enroll failed (fallback to draft path)", e);
      }
      return {
        ok: true,
        matched: true,
        agent_invoked: false,
        reason: "no active job_candidate",
      };
    }
    if (jc.agent_stage === "paused") {
      return {
        ok: true,
        matched: true,
        agent_invoked: false,
        reason: "candidate paused — manager handles",
      };
    }
    const agentResult = await runAgentForCandidate({
      supabase,
      candidate_id: jc.id as number,
      inbound_message_id: String(msg.id),
      inbound_text: text,
      received_at: receivedAt,
    });
    return {
      ok: true,
      matched: true,
      agent_invoked: true,
      agent: agentResult,
    };
  }

  // ───────────────────────────────────────────────────────────────
  // 4b) 매칭 안 됨 → 하드 필터 / triage
  // ───────────────────────────────────────────────────────────────
  if (isHardSpam(phone, text)) {
    await supabase.from("messages").update({ classification: "other" }).eq("id", msg.id);
    return {
      ok: true,
      matched: false,
      classification: "other",
      reason: "hard-filter spam",
    };
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
      return {
        ok: true,
        classification: "pending",
        reason: "applicant create failed",
        triage,
      };
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

    // 3) 지원자에게 안내 SMS 발송.
    //    평시: apply 폼 URL 안내(baemin_apply_invite) — 정식 지원 유도.
    //    비마트 임시중단(baemin_suspended ON): 폼 링크를 보내지 않고 '중단 + 인재풀 동의'(baemin_start) 안내.
    //    ⚠️ 중단 기간엔 B마트 지원서 링크를 절대 보내지 않는다(모집 중처럼 안내 금지).
    const baeminSuspended = !!(await getSystemMessage(supabase, "baemin_suspended"))?.trim();
    let sendBody: string;
    let sentByLabel: string;

    if (baeminSuspended) {
      const nameFill =
        ext.name?.trim() && ext.name.trim() !== "(이름 미확인)" ? ext.name.trim() : "";
      const storedStart = (await getSystemMessage(supabase, "baemin_start"))?.trim();
      const suspendedFallback = [
        `안녕하세요${nameFill ? ` ${nameFill}님` : ""}, 지원해 주셔서 감사합니다!`,
        "",
        "현재 배민 비마트 배송 업무가 배민 측 사정으로 잠시 중단된 상태라, 지금 바로 진행은 어려운 점 양해 부탁드려요.",
        "",
        "다만 지원해 주신 분들은 인재풀에 등록해 두고, 다른 배송·물류 업무 수요가 생기면 가장 먼저 안내드리고 있어요.",
        "",
        `괜찮으시면 다른 업무가 생겼을 때 연락드려도 될까요? "네"라고만 답장 주시면 등록해 둘게요 😊`,
      ].join("\n");
      const filledStored = storedStart ? fillTemplate(storedStart, { 이름: nameFill }) : null;
      const resolved = resolveAutomatedOutboundText(filledStored, suspendedFallback);
      if (!resolved) {
        console.error("[supabase-webhook] unsafe baemin suspended message blocked");
        return { ok: true, classification: "pending", reason: "unsafe automated message", triage };
      }
      sendBody = resolved;
      sentByLabel = "system-baemin-suspended";
    } else {
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
      const filledStored = stored
        ? fillTemplate(stored, { 이름: nameForFill, 지원폼주소: applyUrl })
        : null;
      const resolved = resolveAutomatedOutboundText(filledStored, fallback);
      if (!resolved) {
        console.error("[supabase-webhook] unsafe baemin invite message blocked");
        return { ok: true, classification: "pending", reason: "unsafe automated message", triage };
      }
      sendBody = resolved;
      sentByLabel = "system-baemin-invite";
    }

    let inviteMessageId: string | null = null;
    try {
      const r = await sendSms(phone, sendBody);
      inviteMessageId = r.messageId ?? null;
      if (!r.success) {
        console.error("[supabase-webhook] baemin invite/suspended SMS fail", r.error);
      }
    } catch (e) {
      console.error("[supabase-webhook] baemin invite/suspended SMS exception", e);
    }

    // 4) outbound messages 기록
    await supabase.from("messages").insert({
      applicant_id: applicantId,
      applicant_phone: phone,
      direction: "outbound",
      body: sendBody,
      status: "sent",
      sent_by: sentByLabel,
      solapi_msg_id: inviteMessageId,
      message_type: "sms",
    });

    return {
      ok: true,
      classification: "baemin",
      applicant_id: applicantId,
      triage,
      apply_url_sent: !baeminSuspended,
      baemin_suspended: baeminSuspended,
      agent_invoked: false,
    };
  }

  // 자신 없음 → pending (매니저 인박스)
  await supabase.from("messages").update({ classification: "pending" }).eq("id", msg.id);
  return {
    ok: true,
    classification: "pending",
    triage,
  };
}
