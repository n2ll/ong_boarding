/**
 * POST /api/admin/agent/_multijob-test   (임시 개발용 — 멀티-잡 시뮬레이션 점검)
 *
 * 한 지원자가 2개 공고에 동시 활성인 상태를 목데이터로 만들고,
 * 특정 후보(candidate)에 대해 에이전트를 simulate 모드로 돌려 응답을 확인한다.
 * ⚠️ run은 항상 simulate=true — 실제 SMS는 절대 발송하지 않는다(가짜 번호 + DB 기록만).
 *
 * body:
 *   { action: "seed" }                              → 목데이터 생성/재생성, ids 반환
 *   { action: "run", candidate_id, text }           → 해당 후보로 inbound 1건 + 에이전트 simulate
 *   { action: "cleanup" }                           → 목데이터 삭제
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { runAgentForCandidate } from "@/lib/agent/router";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TEST_PHONE = "010-0000-9001";
const TEST_PREFIX = "[멀티잡테스트]";

export async function POST(req: NextRequest) {
  // 개발 전용 — 운영(프로덕션)에서는 비활성화. 목데이터 시드/삭제가 가능한 도구라 안전장치.
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev only" }, { status: 403 });
  }
  const supabase = createServiceClient();
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    candidate_id?: number;
    text?: string;
  };

  if (body.action === "inspect") {
    const { data: app } = await supabase.from("applicants").select("id, current_job_id").eq("phone", TEST_PHONE).maybeSingle();
    if (!app) return NextResponse.json({ error: "no test applicant" }, { status: 404 });
    const { data: cands } = await supabase
      .from("job_candidates")
      .select("id, job_id, agent_stage, jobs:job_id ( title, branch )")
      .eq("applicant_id", app.id)
      .order("id", { ascending: true });
    const { data: msgs } = await supabase
      .from("messages")
      .select("id, direction, job_id, body, created_at")
      .eq("applicant_id", app.id)
      .order("created_at", { ascending: true });
    return NextResponse.json({ applicant: app, candidates: cands, messages: msgs });
  }

  if (body.action === "cleanup") {
    const { data: app } = await supabase.from("applicants").select("id").eq("phone", TEST_PHONE).maybeSingle();
    if (app) {
      await supabase.from("messages").delete().eq("applicant_id", app.id);
      await supabase.from("job_candidates").delete().eq("applicant_id", app.id);
      await supabase.from("applicants").delete().eq("id", app.id);
    }
    await supabase.from("jobs").delete().ilike("title", `${TEST_PREFIX}%`);
    return NextResponse.json({ ok: true, cleaned: true });
  }

  if (body.action === "seed") {
    // 멱등: 기존 테스트 데이터 제거 후 재생성
    const { data: prev } = await supabase.from("applicants").select("id").eq("phone", TEST_PHONE).maybeSingle();
    if (prev) {
      await supabase.from("messages").delete().eq("applicant_id", prev.id);
      await supabase.from("job_candidates").delete().eq("applicant_id", prev.id);
      await supabase.from("applicants").delete().eq("id", prev.id);
    }
    await supabase.from("jobs").delete().ilike("title", `${TEST_PREFIX}%`);

    // 지원자 — 연습용 소스라 runAgent가 simulate로 동작
    const { data: applicant, error: aErr } = await supabase
      .from("applicants")
      .insert({
        name: "테스트지원자(멀티잡)",
        birth_date: "1980-01-01",
        phone: TEST_PHONE,
        location: "서울시 강서구 (테스트)",
        source: "danggeun_practice",
        branch: "강서",
        branch1: "강서",
        branch2: "마포",
        work_hours: "주말오전, 주말오후",
        own_vehicle: "있음",
        license_type: "보통",
        vehicle_type: "승용",
        self_ownership: "문제 없음",
        available_date: "협의",
        status: "스크리닝 중",
        filter_pass: "Y",
        marketing_consent: true,
        marketing_consent_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (aErr || !applicant) {
      return NextResponse.json({ error: "applicant seed 실패", detail: aErr?.message }, { status: 500 });
    }

    // 공고 A: 강서점 주말, 자차필요
    const { data: jobA } = await supabase
      .from("jobs")
      .insert({
        title: `${TEST_PREFIX} 강서점 주말 배송`,
        body: "강서점 비마트 배송원 모집. 주말(토·일) 오전 근무. 배송에 쓸 자차 필요. 건당 정산, 프로모션 5천원(1~2개월 후 종료 가능).",
        branch: "강서",
        slot: "주말오전",
        vehicle_required: true,
        capacity: 3,
        status: "active",
      })
      .select("id")
      .single();

    // 공고 B: 마포점 평일, 자차 불필요
    const { data: jobB } = await supabase
      .from("jobs")
      .insert({
        title: `${TEST_PREFIX} 마포점 평일 배송`,
        body: "마포점 비마트 배송원 모집. 평일 오전 근무. 자차 불필요(전동카트 지급). 건당 정산.",
        branch: "마포",
        slot: "평일오전",
        vehicle_required: false,
        capacity: 2,
        status: "active",
      })
      .select("id")
      .single();

    if (!jobA || !jobB) {
      return NextResponse.json({ error: "job seed 실패" }, { status: 500 });
    }

    const now = new Date().toISOString();
    // 후보 A (강서·주말·자차필요): 공휴일 확인 필요(주말 슬롯), 자차 재확인 필요
    const { data: candA } = await supabase
      .from("job_candidates")
      .insert({
        job_id: jobA.id,
        applicant_id: applicant.id,
        agent_stage: "screening",
        agent_state: {
          screening: { 프로모션_종료가능성_안내: true, 정산주기_안내: true, 업무시간_체계_이해: true },
          meta: { screening_entered_at: now, entry: "multijob_test" },
        },
      })
      .select("id")
      .single();

    // 후보 B (마포·평일·자차불필요): 자차/공휴일 자동 true(평일+자차X), 본인명의만 남음
    const { data: candB } = await supabase
      .from("job_candidates")
      .insert({
        job_id: jobB.id,
        applicant_id: applicant.id,
        agent_stage: "screening",
        agent_state: {
          screening: {
            프로모션_종료가능성_안내: true,
            정산주기_안내: true,
            업무시간_체계_이해: true,
            자차_재확인: true,
            공휴일_업무여부_확인: true,
          },
          meta: { screening_entered_at: now, entry: "multijob_test" },
        },
      })
      .select("id")
      .single();

    // 직전 outbound(공고 A) 1건 — Phase 0 라우팅이 "마지막 대화 공고=A"로 잡도록
    await supabase.from("messages").insert({
      applicant_id: applicant.id,
      applicant_phone: TEST_PHONE,
      direction: "outbound",
      body: "읽어주셔서 감사해요^^ 강서점 주말 배송 건으로 몇 가지만 확인 부탁드릴게요. 배송에 쓰실 자차 보유 중이실까요? 본인 명의로 정산 받으시는 데 문제 없으실지요?",
      status: "sent",
      sent_by: "agent",
      message_type: "sms",
      job_id: jobA.id,
      created_at: now,
    });

    return NextResponse.json({
      ok: true,
      applicant_id: applicant.id,
      jobA: jobA.id,
      jobB: jobB.id,
      candA: candA?.id,
      candB: candB?.id,
      hint: "run: { action:'run', candidate_id: <candA>, text:'...' }",
    });
  }

  if (body.action === "run") {
    const candidateId = Number(body.candidate_id);
    const text = (body.text ?? "").trim();
    if (!Number.isFinite(candidateId) || !text) {
      return NextResponse.json({ error: "candidate_id, text 필수" }, { status: 400 });
    }
    const { data: jc } = await supabase
      .from("job_candidates")
      .select("id, job_id, applicant_id")
      .eq("id", candidateId)
      .single();
    if (!jc) return NextResponse.json({ error: "candidate 없음" }, { status: 404 });

    const { data: app } = await supabase.from("applicants").select("phone").eq("id", jc.applicant_id).single();
    const now = new Date().toISOString();
    const { data: inbound } = await supabase
      .from("messages")
      .insert({
        applicant_id: jc.applicant_id,
        applicant_phone: app?.phone ?? TEST_PHONE,
        direction: "inbound",
        body: text,
        status: "received",
        sent_by: "multijob-test",
        message_type: "sms",
        job_id: jc.job_id,
        // ⚠️ classification을 채워 두면 Supabase DB webhook(supabase-new-message)이
        //    "already classified"로 즉시 skip → 운영 webhook의 이중 처리/실SMS 시도를 차단한다.
        //    (webhook은 classification IS NULL인 inbound만 처리. 값은 CHECK 제약상 baemin|pending|other 中 하나)
        classification: "other",
        created_at: now,
      })
      .select("id")
      .single();

    const result = await runAgentForCandidate({
      supabase,
      candidate_id: jc.id as number,
      inbound_message_id: String(inbound?.id),
      inbound_text: text,
      simulate: true, // ⚠️ 항상 simulate — 실 SMS 미발송
    });

    // 방금 생성된 outbound(있으면) 본문 회수
    const { data: out } = await supabase
      .from("messages")
      .select("body, direction, job_id, created_at")
      .eq("applicant_id", jc.applicant_id)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return NextResponse.json({ ok: true, agent: result, last_outbound: out });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
