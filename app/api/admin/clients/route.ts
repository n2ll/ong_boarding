/**
 * GET  /api/admin/clients  — 화주사 목록 + 지점 수·진행 공고 수 집계
 * POST /api/admin/clients  — 화주사 신규 생성
 *
 * 주의: jobs.client_id FK는 아직 없으므로(다음 단계) 진행 공고 수는
 *       화주사 소속 지점 이름 ∈ jobs.branch 매칭으로 근사 집계한다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const CLIENT_TYPES = ["baemin_bmart", "danggeun", "general"] as const;

export async function GET() {
  const supabase = createServiceClient();

  const [{ data: clients, error }, { data: branches }, { data: jobs }] = await Promise.all([
    supabase
      .from("clients")
      .select("id, name, client_type, uses_slots, contact_name, contact_phone, memo, active, sort_order")
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true }),
    supabase.from("branches").select("id, name, client_id"),
    supabase.from("jobs").select("branch, status"),
  ]);

  if (error) {
    console.error("[admin/clients GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const branchesByClient = new Map<number, string[]>();
  for (const b of branches ?? []) {
    if (b.client_id == null) continue;
    const arr = branchesByClient.get(b.client_id as number) ?? [];
    arr.push(b.name as string);
    branchesByClient.set(b.client_id as number, arr);
  }

  const activeJobsByBranch = new Map<string, number>();
  for (const j of jobs ?? []) {
    if (!j.branch || j.status === "closed") continue;
    activeJobsByBranch.set(j.branch as string, (activeJobsByBranch.get(j.branch as string) ?? 0) + 1);
  }

  const enriched = (clients ?? []).map((c) => {
    const names = branchesByClient.get(c.id as number) ?? [];
    const activeJobs = names.reduce((sum, n) => sum + (activeJobsByBranch.get(n) ?? 0), 0);
    return { ...c, branches_count: names.length, active_jobs: activeJobs };
  });

  return NextResponse.json({ data: enriched });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      name?: string;
      client_type?: string;
      uses_slots?: boolean;
      contact_name?: string | null;
      contact_phone?: string | null;
      memo?: string | null;
      active?: boolean;
      sort_order?: number;
    };

    const name = (body.name || "").trim();
    if (!name) {
      return NextResponse.json({ error: "화주사 이름을 입력해주세요." }, { status: 400 });
    }
    if (name.length > 80) {
      return NextResponse.json({ error: "화주사 이름이 너무 깁니다 (최대 80자)." }, { status: 400 });
    }
    const client_type =
      body.client_type && (CLIENT_TYPES as readonly string[]).includes(body.client_type)
        ? body.client_type
        : "general";

    const supabase = createServiceClient();

    let sort_order = body.sort_order;
    if (typeof sort_order !== "number") {
      const { data: maxRow } = await supabase
        .from("clients")
        .select("sort_order")
        .order("sort_order", { ascending: false })
        .limit(1)
        .maybeSingle();
      sort_order = (maxRow?.sort_order ?? 0) + 10;
    }

    const { data, error } = await supabase
      .from("clients")
      .insert({
        name,
        client_type,
        uses_slots: body.uses_slots ?? false,
        contact_name: body.contact_name?.trim() || null,
        contact_phone: body.contact_phone?.trim() || null,
        memo: body.memo?.trim() || null,
        active: body.active ?? true,
        sort_order,
      })
      .select("id, name, client_type, uses_slots, contact_name, contact_phone, memo, active, sort_order")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "이미 존재하는 화주사 이름입니다." }, { status: 409 });
      }
      console.error("[admin/clients POST]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error("[admin/clients POST exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
