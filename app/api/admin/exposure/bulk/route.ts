/**
 * J · 타겟 공고 노출 — 수동 오버라이드 일괄 배정.
 *
 * POST   : { job_ids: number[], applicant_ids: number[], mode: 'include'|'exclude' }
 *          선택 인원 × 선택 공고 조합을 job_exposure_targets에 upsert(같은 조합은 mode 갱신).
 *          파이프라인에서 필터·세그먼트로 고른 인원을 여러 공고에 한 번에 배정하는 핵심 동선.
 * DELETE : { job_ids, applicant_ids } — 해당 조합의 오버라이드 행 삭제(규칙 판정으로 복귀).
 *
 * 대상 공고는 실공고(비시스템)만. 지정 노출(targeted)이 아닌 공고에도 기록은 허용하되
 * 응답에 non_targeted로 알려준다(먼저 사람을 골라두고 나중에 공고를 targeted로 바꾸는 순서 지원).
 * 어드민 미들웨어 인증.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { isSystemJobTitle } from "@/lib/jobs";

export const dynamic = "force-dynamic";

const MAX_PAIRS = 5000; // 500명 × 10공고 상한 — 폭주 방지

function parseIds(v: unknown): number[] {
  return Array.isArray(v)
    ? [...new Set(v.map(Number).filter((n) => Number.isFinite(n) && n > 0))]
    : [];
}

async function loadValidJobs(supabase: ReturnType<typeof createServiceClient>, jobIds: number[]) {
  const { data, error } = await supabase
    .from("jobs")
    .select("id, title, exposure")
    .in("id", jobIds);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { id: number; title: string; exposure: string | null }[];
  return rows.filter((j) => !isSystemJobTitle(j.title));
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const jobIds = parseIds(body?.job_ids);
  const applicantIds = parseIds(body?.applicant_ids);
  const mode = body?.mode;
  if (jobIds.length === 0 || applicantIds.length === 0) {
    return NextResponse.json({ error: "job_ids와 applicant_ids가 필요합니다." }, { status: 400 });
  }
  if (mode !== "include" && mode !== "exclude") {
    return NextResponse.json({ error: "mode: 'include' | 'exclude'" }, { status: 400 });
  }
  if (jobIds.length * applicantIds.length > MAX_PAIRS) {
    return NextResponse.json({ error: `조합이 너무 많습니다(최대 ${MAX_PAIRS}).` }, { status: 400 });
  }

  const supabase = createServiceClient();
  let jobs;
  try {
    jobs = await loadValidJobs(supabase, jobIds);
  } catch (e) {
    console.error("[exposure bulk] jobs load failed", e);
    return NextResponse.json({ error: "공고 조회 실패" }, { status: 500 });
  }
  if (jobs.length === 0) {
    return NextResponse.json({ error: "대상 실공고가 없습니다." }, { status: 400 });
  }

  // 존재하는 지원자만 — 삭제된 id가 섞이면 FK 위반으로 배치 전체가 죽는다.
  const { data: appRows, error: appErr } = await supabase
    .from("applicants")
    .select("id")
    .in("id", applicantIds);
  if (appErr) {
    console.error("[exposure bulk] applicants check failed", appErr);
    return NextResponse.json({ error: "지원자 확인 실패" }, { status: 500 });
  }
  const validApplicantIds = (appRows ?? []).map((r) => (r as { id: number }).id);
  if (validApplicantIds.length === 0) {
    return NextResponse.json({ error: "대상 지원자가 없습니다." }, { status: 400 });
  }

  const rows = jobs.flatMap((j) =>
    validApplicantIds.map((aid) => ({ job_id: j.id, applicant_id: aid, mode, added_by: "manager" }))
  );
  // 같은 (job,applicant) 조합이 이미 있으면 mode를 덮어쓴다(include↔exclude 전환).
  const { error } = await supabase
    .from("job_exposure_targets")
    .upsert(rows, { onConflict: "job_id,applicant_id" });
  if (error) {
    console.error("[exposure bulk] upsert failed", error);
    return NextResponse.json({ error: "배정 실패" }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    mode,
    pairs: rows.length,
    jobs: jobs.map((j) => ({ id: j.id, title: j.title })),
    non_targeted: jobs.filter((j) => j.exposure !== "targeted").map((j) => j.id),
    // 걸러진 것들 — 조용한 부분 성공으로 보이지 않게 명시(호출부가 안내 표시).
    skipped_applicants: applicantIds.length - validApplicantIds.length,
    skipped_jobs: jobIds.length - jobs.length,
  });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const jobIds = parseIds(body?.job_ids);
  const applicantIds = parseIds(body?.applicant_ids);
  if (jobIds.length === 0 || applicantIds.length === 0) {
    return NextResponse.json({ error: "job_ids와 applicant_ids가 필요합니다." }, { status: 400 });
  }
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("job_exposure_targets")
    .delete()
    .in("job_id", jobIds)
    .in("applicant_id", applicantIds);
  if (error) {
    console.error("[exposure bulk] delete failed", error);
    return NextResponse.json({ error: "해제 실패" }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
