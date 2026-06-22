/**
 * POST /api/admin/agent/danggeun-practice/reset
 *
 * 연습용 데이터 전체 초기화 — source='danggeun_practice' applicants와
 * 종속 row(messages / message_drafts / job_candidates) 삭제.
 * 라이브(source='danggeun') 데이터는 건드리지 않는다.
 *
 * CASCADE 설정 여부와 무관하게 동작하도록 종속 테이블을 명시적으로 먼저 삭제.
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const supabase = createServiceClient();

    const { data: rows, error: selErr } = await supabase
      .from("applicants")
      .select("id")
      .eq("source", "danggeun_practice");

    if (selErr) {
      console.error("[practice reset] select error", selErr);
      return NextResponse.json({ error: selErr.message }, { status: 500 });
    }

    const ids = (rows ?? []).map((r) => r.id as number);
    if (ids.length === 0) {
      return NextResponse.json({ success: true, deleted: 0 });
    }

    // 종속 → 본체 순서로 삭제 (FK 위반 방지, CASCADE 여부 무관)
    await supabase.from("message_drafts").delete().in("applicant_id", ids);
    await supabase.from("messages").delete().in("applicant_id", ids);
    await supabase.from("job_candidates").delete().in("applicant_id", ids);
    const { error: delErr } = await supabase.from("applicants").delete().in("id", ids);

    if (delErr) {
      console.error("[practice reset] delete error", delErr);
      return NextResponse.json({ error: delErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, deleted: ids.length });
  } catch (err) {
    console.error("[practice reset] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
