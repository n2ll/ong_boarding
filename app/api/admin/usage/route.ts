import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// 이번 달 1일 (KST) — 서버는 UTC라 +9h 보정 후 YYYY-MM-01 (usage.ts kstDay와 동일 방식).
function kstMonthStart(): string {
  const kstMs = Date.now() + 9 * 60 * 60 * 1000;
  return `${new Date(kstMs).toISOString().slice(0, 8)}01`;
}

// KST 기준 오늘 필드 {year, month(1~12), dayOfMonth, daysInMonth}.
function kstToday() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth() + 1;
  const dayOfMonth = kst.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, dayOfMonth, daysInMonth };
}

// N개월 전 YYYY-MM-01 (KST) — 월별 추이 조회 하한.
function monthsAgoStart(n: number): string {
  const { year, month } = kstToday();
  const idx = year * 12 + (month - 1) - n; // 0-based 월 인덱스
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

interface MonthModelAgg {
  model: string;
  call_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
}

interface MonthCost {
  month: string; // YYYY-MM
  ai_cost_krw: number;
  sms_cost_krw: number;
  total_cost_krw: number;
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

    // 월별 비용 추이(최근 6개월) + 월말 예상 — usage_daily_cost(환율 1,500 내장)를 월 단위로 합산.
    const sixMonthStart = monthsAgoStart(5); // 이번 달 포함 6개월
    const { data: costRows, error: costErr } = await supabase
      .from("usage_daily_cost")
      .select("day, ai_cost_krw, sms_cost_krw, total_cost_krw")
      .gte("day", sixMonthStart)
      .order("day", { ascending: true });
    if (costErr) console.error("[usage months fetch error]", costErr);

    const monthAgg = new Map<string, MonthCost>();
    for (const r of (costRows ?? []) as {
      day: string;
      ai_cost_krw: number | null;
      sms_cost_krw: number | null;
      total_cost_krw: number | null;
    }[]) {
      const mkey = String(r.day).slice(0, 7); // YYYY-MM
      const cur = monthAgg.get(mkey) ?? { month: mkey, ai_cost_krw: 0, sms_cost_krw: 0, total_cost_krw: 0 };
      cur.ai_cost_krw += Number(r.ai_cost_krw ?? 0);
      cur.sms_cost_krw += Number(r.sms_cost_krw ?? 0);
      cur.total_cost_krw += Number(r.total_cost_krw ?? 0);
      monthAgg.set(mkey, cur);
    }
    // 최근 6개월 라벨 채우기(빈 달 0)
    const months: MonthCost[] = [];
    for (let i = 5; i >= 0; i--) {
      const mkey = monthsAgoStart(i).slice(0, 7);
      months.push(monthAgg.get(mkey) ?? { month: mkey, ai_cost_krw: 0, sms_cost_krw: 0, total_cost_krw: 0 });
    }

    // 월말 예상 — 이번 달 누적 ÷ 경과일 × 말일수
    const { month: curM, year: curY, dayOfMonth, daysInMonth } = kstToday();
    const curKey = `${curY}-${String(curM).padStart(2, "0")}`;
    const mtd = monthAgg.get(curKey)?.total_cost_krw ?? 0;
    const elapsed = Math.max(1, dayOfMonth);
    const projection = {
      month: curKey,
      mtd_krw: mtd,
      projected_krw: Math.round((mtd / elapsed) * daysInMonth),
      elapsed_days: elapsed,
      days_in_month: daysInMonth,
    };

    return NextResponse.json({
      data: data || [],
      month: { start: monthStart, models: Array.from(byModel.values()) },
      months,
      projection,
    });
  } catch (err) {
    console.error("[usage API error]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
