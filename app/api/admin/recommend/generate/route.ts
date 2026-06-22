import { NextRequest, NextResponse } from "next/server";
import { generateJobPosting } from "@/lib/claude";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { rough?: string };
    const rough = (body.rough || "").trim();
    if (!rough) {
      return NextResponse.json(
        { error: "메모 내용을 입력해주세요." },
        { status: 400 }
      );
    }
    if (rough.length > 4000) {
      return NextResponse.json(
        { error: "메모가 너무 깁니다. 4000자 이내로 입력해주세요." },
        { status: 400 }
      );
    }

    const result = await generateJobPosting(rough, createServiceClient());
    if (!result) {
      return NextResponse.json(
        { error: "공고 생성에 실패했습니다. 잠시 후 다시 시도해주세요." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("[recommend/generate] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
