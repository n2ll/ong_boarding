import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("branches")
    .select("name")
    .eq("active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("[branches] query error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    branches: (data || []).map((r) => r.name as string),
  });
}
