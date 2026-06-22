import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// 어드민 대시보드 비용 카드 — usage_daily_cost view에서 최근 N일 조회.
export async function GET() {
  try {
    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from("usage_daily_cost")
      .select("day, ai_cost_krw, sms_cost_krw, total_cost_krw, ai_call_count, sms_count, lms_count, mms_count, alimtalk_count")
      .order("day", { ascending: false })
      .limit(30);

    if (error) {
      console.error("[usage fetch error]", error);
      return NextResponse.json({ error: "비용 조회 실패" }, { status: 500 });
    }

    return NextResponse.json({ data: data || [] });
  } catch (err) {
    console.error("[usage API error]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
