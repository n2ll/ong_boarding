/**
 * GET /api/apply/job/[id]
 *
 * 공개 지원 랜딩(/apply?job=ID)에서 공고 맥락을 보여주기 위한 최소 정보만 노출한다.
 * 내부 필드(본문·정원·담당자 등)는 제외하고 제목·지점·화주사·모집 여부·차량 필요 여부만 반환.
 * 시스템 공고(__ 접두)와 마감 공고는 모집 종료로 처리.
 */

import { NextRequest, NextResponse } from "next/server";
import { publicJobAvailability } from "@/lib/public-job";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeParams = await params;
  const id = Number(routeParams.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, title, branch, status, closes_at, client_id, branch_id, exposure, recruit_mode, vehicle_required")
    .eq("id", id)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  }

  const availability = publicJobAvailability({
    title: typeof job.title === "string" ? job.title : null,
    status: typeof job.status === "string" ? job.status : null,
    exposure: typeof job.exposure === "string" ? job.exposure : null,
    recruitMode: typeof job.recruit_mode === "string" ? job.recruit_mode : null,
    closesAt: typeof job.closes_at === "string" ? job.closes_at : null,
  });
  // 시스템·지정 노출 공고는 공개 표면에서 숨긴다 — 무인증 엔드포인트라 대상 여부를 검증할 수
  // 없으므로 fail-closed(ID 순차 열거로 제목·화주사가 새는 것 방지). 공개 지원을 받으려면 '전체 노출'로.
  if (availability === "hidden") {
    return NextResponse.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
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
      recruiting: availability === "open",
      vehicle_required: job.vehicle_required !== false,
    },
  });
}
