import { NextRequest, NextResponse } from "next/server";

import { normalizePublicTrackingRef } from "@/lib/acquisition-attribution";
import { parseAcquisitionLinkRequest } from "@/lib/admin/acquisition-link-request";
import { jobPublicPublishingAvailability } from "@/lib/admin/job-publishing";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "요청 형식이 올바르지 않아요." }, { status: 400 });
  }

  const routeParams = await params;
  const request = parseAcquisitionLinkRequest({
    jobId: routeParams.id,
    source: body.source,
  });
  if (!request.ok) {
    return NextResponse.json(
      { error: request.reason === "invalid_job" ? "공고를 확인할 수 없어요." : "지원하지 않는 게시 채널이에요." },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("title, status, closes_at, exposure, recruit_mode")
    .eq("id", request.jobId)
    .maybeSingle();
  if (jobError) {
    console.error("[tracking-links POST] job lookup failed", jobError);
    return NextResponse.json(
      { error: "공고 상태를 확인하지 못했어요. 잠시 후 다시 시도해주세요." },
      { status: 503 },
    );
  }
  if (!job) {
    return NextResponse.json({ error: "공고를 찾을 수 없어요." }, { status: 404 });
  }

  const publishingAvailability = jobPublicPublishingAvailability({
    title: typeof job.title === "string" ? job.title : null,
    status: typeof job.status === "string" ? job.status : null,
    exposure: typeof job.exposure === "string" ? job.exposure : null,
    recruitMode: typeof job.recruit_mode === "string" ? job.recruit_mode : null,
    closesAt: typeof job.closes_at === "string" ? job.closes_at : null,
  });
  if (!publishingAvailability.available) {
    return NextResponse.json(
      { error: publishingAvailability.description },
      { status: 409 },
    );
  }

  const { data, error } = await supabase.rpc("get_or_create_acquisition_tracking_link", {
    p_job_id: request.jobId,
    p_source: request.source,
    p_name: request.campaignName,
  });
  if (error) {
    console.error("[tracking-links POST] tracking link claim failed", error);
    return NextResponse.json(
      { error: "추적 링크를 준비하지 못했어요. 공고 상태를 확인한 뒤 다시 시도해주세요." },
      { status: 409 },
    );
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  const trackingRef = normalizePublicTrackingRef(row?.tracking_ref);
  const campaignId = normalizePublicTrackingRef(row?.campaign_id);
  const linkId = normalizePublicTrackingRef(row?.link_id);
  if (
    !trackingRef
    || !campaignId
    || !linkId
    || Number(row?.job_id) !== request.jobId
    || row?.source !== request.source
  ) {
    console.error("[tracking-links POST] malformed tracking link response");
    return NextResponse.json(
      { error: "추적 링크 결과를 안전하게 확인하지 못했어요. 다시 시도해주세요." },
      { status: 503 },
    );
  }

  return NextResponse.json({
    trackingRef,
    campaignId,
    linkId,
    jobId: request.jobId,
    source: request.source,
    channelLabel: request.channelLabel,
  });
}
