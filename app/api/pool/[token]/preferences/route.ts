import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { parsePoolPreferences } from "@/lib/pool-preferences";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Context = { params: Promise<{ token: string }> };
async function handle(req: NextRequest, context: Context, save: boolean) {
  try {
    const { token } = await context.params;
    if (!UUID.test(token)) return NextResponse.json({ error: "잘못된 링크입니다." }, { status: 400 });
    const preferences = save ? parsePoolPreferences(await req.json()) : null;
    if (save && !preferences) return NextResponse.json({ error: "희망 유형과 지역·요일/시간·차량을 입력해주세요. 각 항목은 240자까지입니다." }, { status: 400 });
    const db = createServiceClient();
    const { data: applicant, error } = await db.from("applicants").select("id").eq("access_token", token).maybeSingle();
    if (error) throw error;
    if (!applicant) return NextResponse.json({ error: "사용할 수 없는 링크입니다." }, { status: 404 });
    if (save) {
      // 자기 신고만 보관한다. 노출 필터·문자 동의·후보 단계는 바꾸지 않는다.
      const { data, error: writeError } = await db.from("pool_events").insert({ applicant_id: applicant.id, event_type: "pool_preferences", meta: preferences }).select("created_at").single();
      if (writeError) throw writeError;
      return NextResponse.json({ preferences, updated_at: data.created_at });
    }
    const { data, error: readError } = await db.from("pool_events").select("meta,created_at").eq("applicant_id", applicant.id).eq("event_type", "pool_preferences").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
    if (readError) throw readError;
    return NextResponse.json({ preferences: parsePoolPreferences(data?.meta), updated_at: data?.created_at ?? null });
  } catch {
    return NextResponse.json({ error: "희망 조건을 처리하지 못했어요. 다시 시도해주세요." }, { status: 500 });
  }
}
export const GET = (req: NextRequest, context: Context) => handle(req, context, false);
export const POST = (req: NextRequest, context: Context) => handle(req, context, true);
