/**
 * GET /api/admin/jobs/[id]/exposure — 공고의 유효 노출 명단.
 *
 * 유효 노출 = (규칙 매칭 ∪ 수동 include) − 수동 exclude. lib/exposure.ts 판정과 동일 소스.
 * 응답: { exposure, rule, effective: [{id,name,via:'rule'|'include'|'both'}], excluded: [{id,name,via}], counts }
 *   - excluded = exclude 오버라이드 전원(규칙 매칭 여부 무관) — 숨기면 복원 경로가 사라진다.
 *     via는 '제외가 없었다면 어떤 근거로 노출됐을지' 참고 표시(rule=규칙 매칭, include=비매칭).
 * 어드민 미들웨어 인증.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { fetchApplicantsForExposure, matchesRule, normalizeRule, type ExposureMode } from "@/lib/exposure";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const supabase = createServiceClient();

  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id, title, exposure, exposure_rule")
    .eq("id", id)
    .maybeSingle();
  if (jobErr) {
    console.error("[job exposure] job load failed", jobErr);
    return NextResponse.json({ error: "공고 조회 실패" }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const rule = normalizeRule((job as { exposure_rule?: unknown }).exposure_rule);

  const { data: overrides, error: ovErr } = await supabase
    .from("job_exposure_targets")
    .select("applicant_id, mode")
    .eq("job_id", id);
  if (ovErr) {
    console.error("[job exposure] overrides load failed", ovErr);
    return NextResponse.json({ error: "오버라이드 조회 실패" }, { status: 500 });
  }
  const modeById = new Map<number, ExposureMode>();
  for (const r of overrides ?? []) {
    const row = r as { applicant_id: number; mode: ExposureMode };
    modeById.set(row.applicant_id, row.mode);
  }

  let applicants;
  try {
    applicants = await fetchApplicantsForExposure(supabase);
  } catch (e) {
    console.error("[job exposure] applicants load failed", e);
    return NextResponse.json({ error: "지원자 조회 실패" }, { status: 500 });
  }

  const now = Date.now();
  const effective: { id: number; name: string | null; via: "rule" | "include" | "both" }[] = [];
  const excluded: { id: number; name: string | null; via: "rule" | "include" | "both" }[] = [];
  for (const a of applicants) {
    const ruleHit = matchesRule(a, rule, now);
    const ov = modeById.get(a.id);
    const via: "rule" | "include" | "both" | null =
      ruleHit && ov === "include" ? "both" : ov === "include" ? "include" : ruleHit ? "rule" : null;
    if (ov === "exclude") {
      // exclude 행은 전부 '제외됨' 목록에 — 규칙 비매칭이어도 숨기면 매니저가 복원할 방법이 없다
      // (수동 include였다가 제외된 사람이 양쪽 목록에서 증발하는 사고 방지).
      excluded.push({ id: a.id, name: a.name, via: ruleHit ? "rule" : "include" });
      continue;
    }
    if (via) effective.push({ id: a.id, name: a.name, via });
  }

  return NextResponse.json({
    job_id: id,
    exposure: (job as { exposure?: string }).exposure ?? "all",
    rule,
    effective,
    excluded,
    counts: {
      effective: effective.length,
      by_rule: effective.filter((e) => e.via !== "include").length,
      manual_include: effective.filter((e) => e.via !== "rule").length,
      excluded: excluded.length,
    },
  });
}
