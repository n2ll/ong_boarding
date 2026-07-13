/**
 * GET /api/admin/pull-preview — '지원자 화면 미리보기' 토큰 조회.
 *
 * 공고 탭의 [지원자 화면] 버튼이 호출 — 반환된 토큰으로 /p/[token]을 새 탭에 열어
 * 지원자에게 보이는 맞춤링크 화면(공고 카드·마감 카드·관심 버튼)을 그대로 확인한다.
 *
 * 토큰 선택:
 *  ① prompt_examples(category='system_message', title='pull_preview_token') body에 지정된
 *     테스트 지원자 access_token — 실 지원자 데이터 오염(조회·관심 이벤트) 없이 미리보기 전용.
 *  ② 미지정/무효면 폴백: access_token이 있는 최신 지원자.
 *
 * 인증은 middleware(/api/admin Basic Auth)가 담당.
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServiceClient();

  // ① 지정 토큰 (테스트 지원자)
  const { data: settings } = await supabase
    .from("prompt_examples")
    .select("body")
    .eq("category", "system_message")
    .eq("title", "pull_preview_token")
    .limit(1);
  const fixed = settings?.[0]?.body?.trim();
  if (fixed) {
    const { data: rows } = await supabase
      .from("applicants")
      .select("name, access_token")
      .eq("access_token", fixed)
      .limit(1);
    const a = rows?.[0];
    if (a?.access_token) {
      return NextResponse.json({ token: a.access_token, name: a.name ?? null, source: "setting" });
    }
  }

  // ② 폴백 — 링크 토큰이 있는 최신 지원자
  const { data: latestRows } = await supabase
    .from("applicants")
    .select("name, access_token")
    .not("access_token", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const latest = latestRows?.[0];
  if (!latest?.access_token) {
    return NextResponse.json(
      { error: "미리보기에 쓸 지원자 링크 토큰이 없어요. 지원자가 1명 이상 필요합니다." },
      { status: 404 }
    );
  }
  return NextResponse.json({ token: latest.access_token, name: latest.name ?? null, source: "fallback" });
}
