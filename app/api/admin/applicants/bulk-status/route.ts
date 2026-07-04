/**
 * POST /api/admin/applicants/bulk-status
 *
 * 파이프라인 일괄 상태 변경 전용 — {ids: number[], status: string}.
 * 클라이언트가 건별 PATCH를 수백 번 쏘던 방식을 단일 쿼리로 대체하고,
 * 단건 PATCH(applicants/[id])와 동일한 status 부수효과를 서버에서 보장한다:
 *   - 부적합/이탈  → current_branch 비움 + churned_at 기록
 *   - 확정인력/대기자 → confirmed_branch 비어 있으면 branch1로 채움 (행별)
 *   - 확정인력     → hired_at 최초 1회 기록 (행별, 기존 값 유지)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { VALID_STATUS } from "@/lib/admin/applicant-validation";

export const dynamic = "force-dynamic";

const MAX_IDS = 500;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const ids: unknown = body?.ids;
  const status: unknown = body?.status;

  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((v) => Number.isFinite(Number(v)))) {
    return NextResponse.json({ error: "ids must be a non-empty number array" }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json({ error: `too many ids (max ${MAX_IDS})` }, { status: 400 });
  }
  if (typeof status !== "string" || !VALID_STATUS.has(status)) {
    return NextResponse.json({ error: `invalid status: ${status}` }, { status: 400 });
  }

  const numIds = ids.map((v) => Number(v));
  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const updates: Record<string, unknown> = { status };
  if (status === "부적합" || status === "이탈") {
    updates.current_branch = null;
    updates.churned_at = now;
  }

  // 행별 조건이 필요한 부수효과(confirmed_branch 채움·hired_at 최초 기록)는
  // 대상 행을 먼저 조회해 두 그룹으로 나눠 처리한다 — 쿼리 수는 최대 3회로 고정.
  let fillBranch: { id: number; branch1: string }[] = [];
  let hiredAtIds: number[] = [];
  if (status === "확정인력" || status === "대기자") {
    const { data: rows, error: selErr } = await supabase
      .from("applicants")
      .select("id, status, hired_at, confirmed_branch, branch1")
      .in("id", numIds);
    if (selErr) {
      return NextResponse.json({ error: selErr.message }, { status: 500 });
    }
    fillBranch = (rows ?? [])
      .filter((r) => !r.confirmed_branch && r.branch1)
      .map((r) => ({ id: r.id as number, branch1: r.branch1 as string }));
    if (status === "확정인력") {
      hiredAtIds = (rows ?? [])
        .filter((r) => r.status !== "확정인력" && !r.hired_at)
        .map((r) => r.id as number);
    }
  }

  const { data: updated, error } = await supabase
    .from("applicants")
    .update(updates)
    .in("id", numIds)
    .select("id");

  if (error) {
    console.error("[bulk-status error]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 확정 시각 — 처음 확정인력이 되는 행만 (실패해도 본 갱신은 유지, non-fatal)
  if (hiredAtIds.length > 0) {
    const { error: hiredErr } = await supabase
      .from("applicants")
      .update({ hired_at: now })
      .in("id", hiredAtIds);
    if (hiredErr) console.error("[bulk-status] hired_at update failed", hiredErr);
  }

  // 확정지점 자동 채움 — branch1을 행별로 복사해야 하므로 SQL 한 방이 안 됨.
  // 사전 조회한 값을 재사용해 건별 UPDATE, 실패는 로그만 (non-fatal).
  for (const { id: fid, branch1 } of fillBranch) {
    const { error: fbErr } = await supabase
      .from("applicants")
      .update({ confirmed_branch: branch1 })
      .eq("id", fid);
    if (fbErr) console.error("[bulk-status] confirmed_branch fill failed", fid, fbErr);
  }

  return NextResponse.json({
    success: true,
    requested: numIds.length,
    updated: (updated ?? []).length,
  });
}
