import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from("device_heartbeat")
      .select("*")
      .order("last_seen_at", { ascending: false })
      .limit(10);

    if (error) {
      console.error("[heartbeat fetch error]", error);
      return NextResponse.json(
        { error: "조회 실패" },
        { status: 500 }
      );
    }

    return NextResponse.json({ data: data || [] });
  } catch (err) {
    console.error("[heartbeat API error]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
