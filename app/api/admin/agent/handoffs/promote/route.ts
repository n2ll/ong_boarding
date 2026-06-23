/**
 * 인계 → 자산화 (③-1).
 *
 * 매니저가 인계 큐에서 답한 단가·정책 건을, 해당 공고의 pay_info/policy_notes에 반영한다.
 * 다음에 같은 질문이 오면 에이전트가 [현재 공고] 컨텍스트로 직접 답해(=②) 인계 자체가 줄어든다.
 *
 *  GET  ?candidate_id=  → 반영 모달 프리필용 (현재 공고 값 + 매니저가 직접 보낸 마지막 답변)
 *  POST { candidate_id, field, text } → jobs.pay_info | jobs.policy_notes 갱신
 *
 * ⚠️ '정보 제공'을 위한 사실 적재일 뿐, 근무 확정/배정과는 무관하다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const FIELDS = new Set(["pay_info", "policy_notes"]);

// 시스템 자동/AI 발송 라벨 — 이 외 outbound는 '매니저가 직접 보낸 답변'으로 본다.
const NON_MANUAL_SENT_BY = new Set([
  "agent",
  "agent-practice",
  "system-auto",
  "system-onboarding-reminder",
  "system-reminder",
  "danggeun-start",
  "baemin-start",
  "danggeun-practice-start",
  "danggeun-recommend",
]);

async function loadCandidateJob(candidateId: number) {
  const supabase = createServiceClient();
  const { data: jc } = await supabase
    .from("job_candidates")
    .select("id, job_id, applicant_id, jobs:job_id ( id, title, pay_info, policy_notes )")
    .eq("id", candidateId)
    .maybeSingle();
  return { supabase, jc } as const;
}

export async function GET(req: NextRequest) {
  const candidateId = Number(new URL(req.url).searchParams.get("candidate_id"));
  if (!Number.isFinite(candidateId)) {
    return NextResponse.json({ error: "candidate_id 필요" }, { status: 400 });
  }
  const { supabase, jc } = await loadCandidateJob(candidateId);
  if (!jc) return NextResponse.json({ error: "후보 없음" }, { status: 404 });

  const job = (jc.jobs ?? null) as unknown as { id: number; title: string; pay_info: string | null; policy_notes: string | null } | null;
  const isSystem = !job || (typeof job.title === "string" && job.title.startsWith("__"));

  // 이 지원자에게 매니저가 직접 보낸 가장 최근 답변(프리필 기본값)
  const { data: outs } = await supabase
    .from("messages")
    .select("body, sent_by, created_at")
    .eq("applicant_id", jc.applicant_id)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(20);
  const lastManual = (outs ?? []).find((m) => !NON_MANUAL_SENT_BY.has((m.sent_by as string) ?? ""))?.body ?? null;

  return NextResponse.json({
    ok: true,
    job_id: job?.id ?? null,
    job_title: job?.title ?? null,
    is_system: isSystem,
    current_pay_info: job?.pay_info ?? null,
    current_policy_notes: job?.policy_notes ?? null,
    last_manual_reply: lastManual,
  });
}

export async function POST(req: NextRequest) {
  let body: { candidate_id?: number; field?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const candidateId = Number(body.candidate_id);
  const field = body.field ?? "";
  const text = (body.text ?? "").trim();
  if (!Number.isFinite(candidateId) || !FIELDS.has(field) || !text) {
    return NextResponse.json({ error: "candidate_id·field(pay_info|policy_notes)·text 필수" }, { status: 400 });
  }

  const { supabase, jc } = await loadCandidateJob(candidateId);
  if (!jc) return NextResponse.json({ error: "후보 없음" }, { status: 404 });
  const job = (jc.jobs ?? null) as unknown as { id: number; title: string } | null;
  if (!job || (typeof job.title === "string" && job.title.startsWith("__"))) {
    return NextResponse.json({ error: "공고 미지정(시스템) 건은 공고에 반영할 수 없어요." }, { status: 400 });
  }

  const { error } = await supabase.from("jobs").update({ [field]: text }).eq("id", job.id);
  if (error) {
    console.error("[handoffs/promote]", error);
    return NextResponse.json({ error: "반영 실패" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, job_id: job.id, field });
}
