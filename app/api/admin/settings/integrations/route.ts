/**
 * GET /api/admin/settings/integrations
 * 외부 연동 실연결 상태 — 서버 환경변수 설정 여부를 boolean으로만 노출(값은 노출하지 않음).
 */

import { NextResponse } from "next/server";
import { getSlackNotificationStatus } from "@/lib/slack";

export const dynamic = "force-dynamic";

export async function GET() {
  const slack = getSlackNotificationStatus();
  const integrations = [
    {
      key: "claude",
      configured: !!process.env.CLAUDE_API,
      required: ["CLAUDE_API"],
    },
    {
      key: "solapi",
      configured: !!(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET),
      // 알림톡(카카오)까지 쓰려면 PFID 필요
      kakao_ready: !!process.env.SOLAPI_PFID,
      required: ["SOLAPI_API_KEY", "SOLAPI_API_SECRET"],
    },
    {
      key: "supabase",
      configured: !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      required: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
    },
    {
      key: "slack",
      configured: slack.webhookConfigured,
      enabled: slack.enabled,
      active: slack.active,
      required: ["SLACK_WEBHOOK_URL"],
    },
    {
      key: "naver_geocode",
      configured: !!(process.env.NAVER_NCLOUD_KEY_ID && process.env.NAVER_NCLOUD_KEY_SECRET),
      required: ["NAVER_NCLOUD_KEY_ID", "NAVER_NCLOUD_KEY_SECRET"],
    },
  ];

  return NextResponse.json({ data: integrations });
}
