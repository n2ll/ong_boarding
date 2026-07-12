/**
 * GET /api/admin/pool-events/interested?job_id=N
 *
 * 특정 공고에 '관심 있음'(interest_click)을 남긴 지원자 id 목록(중복 제거).
 * 파이프라인 '공고 관심자 선택'(사후관리 — 대기 안내 발송 대상 원클릭 선별)용.
 * interest-queue와 달리 처리 여부(contacted_at 등)와 무관하게 관심 이력 전체를 준다.
 * 확정인력 제외 등 대상 정제는 클라이언트(파이프라인)가 담당.
 * 인증은 middleware의 /api/admin/* Basic Auth에 위임.
 *
 * 응답: { applicantIds: number[] }
 *
 * ── ?detail=1 (공고 마감 안내 대상 산정 — Jobs 마감 모달용) ──
 * 미선발 관심자 = (interest_click ∪ 이 공고 job_candidates 전 단계) 중
 *   확정인력·인력풀 제외(부적합/이탈)·수신거부·이미 대기 안내(waitlist_notice) 수신·
 *   전화번호/access_token 없음(맞춤링크 발송 불가)을 뺀 인원.
 * 발송 자체는 bulk-send가 재차 가드하지만, 모달의 'N명' 표시가 실제 발송 수와
 * 어긋나지 않게 여기서 미리 걸러 준다.
 *
 * 응답: { applicantIds, targets: {id,name,phone,access_token}[], waitlistNotifiedCount }
 *   waitlistNotifiedCount = 이 공고 waitlist_notice 수신 인원(distinct)
 *   — 공고 재개 시 '대기자 N명' 힌트의 근거('결원 시 우선 안내' 역조회).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const jobId = Number(req.nextUrl.searchParams.get("job_id"));
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "job_id must be a number" }, { status: 400 });
  }
  const detail = req.nextUrl.searchParams.get("detail") === "1";

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("pool_events")
    .select("applicant_id")
    .eq("event_type", "interest_click")
    .eq("job_id", jobId);

  if (error) {
    console.error("[pool-events/interested]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const applicantIds = [...new Set((data ?? []).map((r) => r.applicant_id as number))];
  if (!detail) {
    return NextResponse.json({ applicantIds });
  }

  // 이 공고 후보 전원 — 관심 표시(agent_stage NULL/abort)든 진행 중이었든, 선발(확정) 여부는
  // 아래 applicants.status로 거른다('진행 중이었지만 확정 안 된 후보' 포함).
  const { data: cands, error: candErr } = await supabase
    .from("job_candidates")
    .select("applicant_id")
    .eq("job_id", jobId);
  if (candErr) {
    console.error("[pool-events/interested] job_candidates", candErr);
    return NextResponse.json({ error: candErr.message }, { status: 500 });
  }

  // 이미 이 공고 대기 안내를 받은 인원 — 충원 완료 자동 안내(engage)든 마감 안내든 중복 발송 제외.
  const { data: notices, error: noticeErr } = await supabase
    .from("pool_events")
    .select("applicant_id")
    .eq("event_type", "waitlist_notice")
    .eq("job_id", jobId);
  if (noticeErr) {
    console.error("[pool-events/interested] waitlist_notice", noticeErr);
    return NextResponse.json({ error: noticeErr.message }, { status: 500 });
  }
  const notified = new Set((notices ?? []).map((r) => r.applicant_id as number));

  const unionIds = [
    ...new Set([...applicantIds, ...(cands ?? []).map((r) => r.applicant_id as number)]),
  ];

  let targets: { id: number; name: string | null; phone: string; access_token: string }[] = [];
  if (unionIds.length > 0) {
    const { data: apps, error: appErr } = await supabase
      .from("applicants")
      .select("id, name, phone, access_token, status, sms_opt_out_at")
      .in("id", unionIds);
    if (appErr) {
      console.error("[pool-events/interested] applicants", appErr);
      return NextResponse.json({ error: appErr.message }, { status: 500 });
    }
    targets = (apps ?? [])
      .filter((a) => {
        const status = (a.status as string | null) ?? "";
        if (status === "확정인력") return false; // 선발된 인원 — 안내 대상 아님
        if (status === "부적합" || status === "이탈") return false; // 인력풀 제외
        if (a.sms_opt_out_at) return false; // 수신거부
        if (notified.has(a.id as number)) return false; // 이미 대기 안내 수신
        // 문구에 맞춤링크가 들어가므로 번호·토큰 없는 인원은 대상에서 제외(발송 시 깨짐 방지).
        return !!a.phone && !!a.access_token;
      })
      .map((a) => ({
        id: a.id as number,
        name: (a.name as string | null) ?? null,
        phone: a.phone as string,
        access_token: a.access_token as string,
      }));
  }

  return NextResponse.json({ applicantIds, targets, waitlistNotifiedCount: notified.size });
}
