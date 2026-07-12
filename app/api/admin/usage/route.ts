import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// 이번 달 1일 (KST) — 서버는 UTC라 +9h 보정 후 YYYY-MM-01 (usage.ts kstDay와 동일 방식).
function kstMonthStart(): string {
  const kstMs = Date.now() + 9 * 60 * 60 * 1000;
  return `${new Date(kstMs).toISOString().slice(0, 8)}01`;
}

interface MonthModelAgg {
  model: string;
  call_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
}

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

    // 이번 달 모델별 Claude 사용량 집계 — 두뇌 탭 'AI 사용량' 카드용 (비용 환산은 클라이언트).
    const monthStart = kstMonthStart();
    const { data: monthRows, error: monthError } = await supabase
      .from("ai_usage_daily")
      .select("model, tokens_in, tokens_out, cache_read, call_count")
      .gte("day", monthStart);
    if (monthError) console.error("[usage month fetch error]", monthError);

    const byModel = new Map<string, MonthModelAgg>();
    for (const r of (monthRows ?? []) as { model: string; tokens_in: number | null; tokens_out: number | null; cache_read: number | null; call_count: number | null }[]) {
      const cur = byModel.get(r.model) ?? { model: r.model, call_count: 0, tokens_in: 0, tokens_out: 0, cache_read: 0 };
      cur.call_count += r.call_count ?? 0;
      cur.tokens_in += r.tokens_in ?? 0;
      cur.tokens_out += r.tokens_out ?? 0;
      cur.cache_read += r.cache_read ?? 0;
      byModel.set(r.model, cur);
    }

    return NextResponse.json({
      data: data || [],
      month: { start: monthStart, models: Array.from(byModel.values()) },
    });
  } catch (err) {
    console.error("[usage API error]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
