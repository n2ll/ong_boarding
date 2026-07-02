import { NextResponse } from "next/server";

/**
 * Cron/머신 트리거 엔드포인트 인증.
 *
 * `Authorization: Bearer <CRON_SECRET>`만 허용한다. (위조 가능한 user-agent 검사 제거)
 * CRON_SECRET 미설정 시 fail-closed — 항상 401.
 *
 * Vercel Cron은 프로젝트에 CRON_SECRET 환경변수가 설정돼 있으면 자동으로
 * `Authorization: Bearer <CRON_SECRET>` 헤더를 붙여 호출하므로 vercel.json 수정은 불필요하다.
 * 수동/스크립트 호출 시에도 같은 헤더를 보내야 한다.
 *
 * @returns 인증 실패 시 401 NextResponse, 통과 시 null.
 */
export function requireCronAuth(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron-auth] CRON_SECRET not set — refusing (fail-closed)");
    return NextResponse.json({ error: "cron auth not configured" }, { status: 401 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
