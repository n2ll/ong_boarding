import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { isValidTestJobIds } from "@/lib/agent/kill-switch";
import { loadPilotCandidates } from "@/lib/admin/agent-pilot-targets";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const ids = (req.nextUrl.searchParams.get("job_ids") ?? "").split(",").map(Number);
  if (!isValidTestJobIds(ids)) return NextResponse.json({ error: "공고를 1~3개 선택해주세요." }, { status: 400 });
  try {
    const rows = await loadPilotCandidates(createServiceClient(), ids);
    const targets = new Map<number, { id: number; name: string; phone_suffix: string; job_ids: number[] }>();
    for (const row of rows) {
      const target = targets.get(row.applicant_id) ?? { id: row.applicant_id, name: row.applicants?.name ?? "이름 없음", phone_suffix: row.applicants?.phone?.slice(-4) ?? "", job_ids: [] };
      target.job_ids.push(row.job_id); targets.set(row.applicant_id, target);
    }
    return NextResponse.json({ targets: [...targets.values()] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "대상 조회 실패" }, { status: 409 });
  }
}
