/**
 * GET    /api/admin/cost-ledger?month=YYYY-MM — 해당 월(기본: KST 현재 월) 운영비 목록 + 합계
 * POST   /api/admin/cost-ledger               — 운영비 수기 입력
 * DELETE /api/admin/cost-ledger?id=           — 행 삭제 (입력 실수 정정용)
 *
 * 인증은 middleware.ts의 /api/admin/* Basic Auth에 위임.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { COST_CATEGORIES, kstMonth } from "@/lib/sos";

export const dynamic = "force-dynamic";

const MONTH_RE = /^\d{4}-\d{2}$/;

export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month") || kstMonth();
  if (!MONTH_RE.test(month)) {
    return NextResponse.json({ error: "month는 'YYYY-MM' 형식이어야 합니다." }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: rows, error } = await supabase
    .from("cost_ledger")
    .select("*")
    .eq("month", month)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[cost-ledger GET error]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let total = 0;
  const by_category: Record<string, number> = {};
  for (const r of rows ?? []) {
    const amount = typeof r.amount_krw === "number" ? r.amount_krw : 0;
    total += amount;
    by_category[r.category] = (by_category[r.category] ?? 0) + amount;
  }

  return NextResponse.json({ month, rows: rows ?? [], total, by_category });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  const month: unknown = body?.month;
  if (typeof month !== "string" || !MONTH_RE.test(month)) {
    return NextResponse.json({ error: "month는 'YYYY-MM' 형식이어야 합니다." }, { status: 400 });
  }
  const category: unknown = body?.category;
  if (typeof category !== "string" || !(category in COST_CATEGORIES)) {
    return NextResponse.json({ error: `category 값이 잘못되었습니다: ${category}` }, { status: 400 });
  }
  const amount = Number(body?.amount_krw);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: "amount_krw는 양의 정수여야 합니다." }, { status: 400 });
  }
  const memo = typeof body?.memo === "string" && body.memo.trim() ? body.memo.trim() : null;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("cost_ledger")
    .insert({ month, category, amount_krw: amount, memo })
    .select("*")
    .single();

  if (error) {
    console.error("[cost-ledger POST error]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("cost_ledger")
    .delete()
    .eq("id", id)
    .select("id");

  if (error) {
    console.error("[cost-ledger DELETE error]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "해당 항목을 찾을 수 없습니다." }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
