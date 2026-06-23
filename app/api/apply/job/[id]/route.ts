/**
 * GET /api/apply/job/[id]
 *
 * 공개 지원 랜딩(/apply?job=ID)에서 공고 맥락을 보여주기 위한 최소 정보만 노출한다.
 * 내부 필드(본문·정원·담당자 등)는 제외하고 제목·지점·화주사·모집 여부만 반환.
 * 시스템 공고(__ 접두)와 마감 공고는 모집 종료로 처리.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, title, branch, status, client_id, branch_id")
    .eq("id", id)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  }

  // 내부 시스템 공고는 공개 지원 대상이 아님
  if (typeof job.title === "string" && job.title.startsWith("__")) {
    return NextResponse.json({ error: "지원할 수 없는 공고입니다." }, { status: 404 });
  }

  let clientName: string | null = null;
  if (job.client_id) {
    const { data: client } = await supabase
      .from("clients")
      .select("name")
      .eq("id", job.client_id)
      .maybeSingle();
    clientName = (client?.name as string | undefined) ?? null;
  }

  return NextResponse.json({
    job: {
      id: job.id,
      title: job.title,
      branch: job.branch ?? null,
      client_name: clientName,
      recruiting: job.status === "active",
    },
  });
}
