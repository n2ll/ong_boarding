import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type DraftAction = "ignored" | "used" | "edited";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = (await req.json()) as {
      action: DraftAction;
      used_message_id?: string;
    };
    if (!["ignored", "used", "edited"].includes(body.action)) {
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
    }
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("message_drafts")
      .update({
        status: body.action,
        used_message_id: body.used_message_id || null,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", params.id)
      .select()
      .single();
    if (error) {
      console.error("[drafts/:id] error", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    console.error("[drafts/:id] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
