/**
 * GET /api/apply/job/[id]
 *
 * 공개 지원 랜딩(/apply?job=ID)에서 공고 맥락을 보여주기 위한 최소 정보만 노출한다.
 * 내부 필드(본문·정원·담당자 등)는 제외하고 제목·지점·화주사·모집 여부·차량 필요 여부만 반환.
 * 시스템 공고(__ 접두)와 마감 공고는 모집 종료로 처리.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  applicationActiveFixedBranchName,
  applicationBranchContext,
  applicationBranchName,
} from "@/lib/application-branch";
import {
  applicationFixedWorkHour,
  applyJobIntent,
  classifyApplyJobLookup,
} from "@/lib/apply-job-flow";
import { publicJobAvailability } from "@/lib/public-job";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeParams = await params;
  const intent = applyJobIntent(routeParams.id);
  if (intent.kind !== "job") {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const id = intent.id;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("id, title, branch, status, closes_at, client_id, branch_id, exposure, recruit_mode, vehicle_required, slot, slot_keys")
    .eq("id", id)
    .maybeSingle();

  const lookup = classifyApplyJobLookup(data, error);
  if (lookup.kind === "retryable") {
    return NextResponse.json(
      { error: "공고 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", retryable: true },
      { status: lookup.status },
    );
  }
  if (lookup.kind === "missing") {
    return NextResponse.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  }
  const job = lookup.job;

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
    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("name")
      .eq("id", job.client_id)
      .maybeSingle();
    if (clientError) {
      return NextResponse.json(
        { error: "공고의 화주사 정보를 확인하지 못했습니다.", retryable: true },
        { status: 503 },
      );
    }
    clientName = (client?.name as string | undefined) ?? null;
  }

  let fixedBranch: string | null = null;
  if (typeof job.branch_id === "number") {
    let fixedBranchQuery = supabase
      .from("branches")
      .select("name, active, client_id")
      .eq("id", job.branch_id)
      .eq("active", true);
    if (typeof job.client_id === "number") {
      fixedBranchQuery = fixedBranchQuery.eq("client_id", job.client_id);
    }
    const { data: branch, error: branchError } = await fixedBranchQuery
      .maybeSingle();
    fixedBranch = applicationActiveFixedBranchName({
      name: typeof branch?.name === "string" ? branch.name : null,
      active: branch?.active === true,
      clientId: typeof branch?.client_id === "number" ? branch.client_id : null,
      jobClientId: typeof job.client_id === "number" ? job.client_id : null,
    });
    if (branchError || !fixedBranch) {
      return NextResponse.json(
        { error: "공고의 근무지 정보를 확인하지 못했습니다.", retryable: true },
        { status: 503 },
      );
    }
  } else {
    const legacyBranchName = applicationBranchName(
      typeof job.branch === "string" ? job.branch : null,
    );
    if (legacyBranchName) {
      if (typeof job.client_id !== "number") {
        return NextResponse.json(
          { error: "공고의 근무지 정보를 확인하지 못했습니다.", retryable: true },
          { status: 503 },
        );
      }
      const { data: branch, error: branchError } = await supabase
        .from("branches")
        .select("name, active, client_id")
        .eq("client_id", job.client_id)
        .eq("name", legacyBranchName)
        .eq("active", true)
        .maybeSingle();
      fixedBranch = applicationActiveFixedBranchName({
        name: typeof branch?.name === "string" ? branch.name : null,
        active: branch?.active === true,
        clientId: typeof branch?.client_id === "number" ? branch.client_id : null,
        jobClientId: job.client_id,
      });
      if (branchError || !fixedBranch) {
        return NextResponse.json(
          { error: "공고의 근무지 정보를 확인하지 못했습니다.", retryable: true },
          { status: 503 },
        );
      }
    }
  }

  let branches: string[] = [];
  if (!fixedBranch && typeof job.client_id === "number") {
    const { data: branchRows, error: branchesError } = await supabase
      .from("branches")
      .select("name")
      .eq("client_id", job.client_id)
      .eq("active", true)
      .order("sort_order", { ascending: true });
    if (branchesError) {
      return NextResponse.json(
        { error: "선택 가능한 근무지를 확인하지 못했습니다.", retryable: true },
        { status: 503 },
      );
    }
    branches = (branchRows ?? [])
      .map((branch) => applicationBranchName(
        typeof branch.name === "string" ? branch.name : null,
      ))
      .filter((branch): branch is string => branch !== null);
  }

  const branchContext = applicationBranchContext({
    fixedBranch,
    allowChoice: branches.length > 0,
    activeBranches: branches,
  });

  return NextResponse.json({
    job: {
      id: job.id,
      title: job.title,
      branch: branchContext.mode === "fixed" ? branchContext.branch : null,
      branch_mode: branchContext.mode,
      branches: branchContext.mode === "choice" ? branchContext.branches : [],
      client_name: clientName,
      recruiting: availability === "open",
      vehicle_required: job.vehicle_required !== false,
      fixed_work_hour: applicationFixedWorkHour({
        slot: job.slot,
        slotKeys: job.slot_keys,
      }),
    },
  });
}
