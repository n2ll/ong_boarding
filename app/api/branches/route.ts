import { NextResponse } from "next/server";
import { applicationBranchName } from "@/lib/application-branch";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServiceClient();
  const { data: clients, error: clientsError } = await supabase
    .from("clients")
    .select("id")
    .eq("client_type", "baemin_bmart")
    .eq("active", true);

  if (clientsError) {
    console.error("[branches] client scope query error", clientsError);
    return NextResponse.json({ error: "지점 범위를 확인하지 못했습니다." }, { status: 503 });
  }

  const clientIds = (clients ?? [])
    .map((client) => Number(client.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (clientIds.length === 0) return NextResponse.json({ branches: [] });

  const { data, error } = await supabase
    .from("branches")
    .select("name")
    .in("client_id", clientIds)
    .eq("active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("[branches] query error", error);
    return NextResponse.json({ error: "지점 목록을 확인하지 못했습니다." }, { status: 503 });
  }

  return NextResponse.json({
    branches: (data || [])
      .map((row) => applicationBranchName(typeof row.name === "string" ? row.name : null))
      .filter((branch): branch is string => branch !== null),
  });
}
