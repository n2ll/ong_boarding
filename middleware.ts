import { NextRequest, NextResponse } from "next/server";

/**
 * 어드민 표면 보호 (P0-1b, 임시 공유 비밀번호).
 *
 * `/(admin)` 대시보드 페이지 + `/api/admin/*`(cron 제외)를 HTTP Basic Auth로 보호한다.
 * 공개로 둬야 하는 경로(지원 폼·공개 API·인입 웹훅·머신 cron)는 통과시킨다.
 *
 * 자격증명: env `ADMIN_PASSWORD`(필수), `ADMIN_USER`(선택, 기본 'ongoing').
 * 프로덕션에서 ADMIN_PASSWORD 미설정 시 fail-closed(503). 개발 환경에선 경고 없이 통과.
 *
 * 브라우저는 최초 1회 네이티브 프롬프트로 자격증명을 받고 이후 같은 오리진 요청
 * (페이지 내 fetch 포함)에 자동 첨부하므로 어드민 UI 버튼도 코드 변경 없이 동작한다.
 *
 * 참고: `/api/agent/*`, `/api/messages/*` 등 비-admin API는 이 미들웨어 범위 밖이다(별도 처리).
 */

// 공개(비보호) 경로 — 지원자·SMS Gateway·Vercel cron이 접근.
const PUBLIC_API_PREFIXES = [
  "/api/apply",
  "/api/webhooks",
  "/api/branches",
  "/api/admin/cron", // 머신 트리거 — 자체 Bearer(CRON_SECRET)로 인증
];

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Ongboarding Admin", charset="UTF-8"' },
  });
}

function checkBasicAuth(req: NextRequest): boolean {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    // 미설정: 프로덕션은 호출부에서 503으로 차단. 개발 환경은 통과.
    return process.env.NODE_ENV !== "production";
  }
  const user = process.env.ADMIN_USER || "ongoing";
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  return decoded.slice(0, idx) === user && decoded.slice(idx + 1) === password;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 정적 자산(확장자 있는 경로)은 통과.
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    // 공개 API + 머신 cron은 통과.
    const isPublic = PUBLIC_API_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(p + "/")
    );
    if (isPublic) return NextResponse.next();
    // /api/admin/*(cron 제외)만 보호. 그 외 API는 범위 밖 → 통과.
    if (!pathname.startsWith("/api/admin/")) return NextResponse.next();
  } else {
    // 페이지: 지원 폼만 공개, 나머지(어드민 루트 포함) 보호.
    if (pathname === "/apply" || pathname.startsWith("/apply/")) {
      return NextResponse.next();
    }
  }

  // 여기 도달 = 보호 대상.
  if (process.env.NODE_ENV === "production" && !process.env.ADMIN_PASSWORD) {
    return NextResponse.json(
      { error: "admin auth not configured (ADMIN_PASSWORD 미설정)" },
      { status: 503 }
    );
  }
  if (!checkBasicAuth(req)) return unauthorized();
  return NextResponse.next();
}

export const config = {
  // 정적 자산·Next 내부는 제외하고 나머지는 미들웨어 함수에서 판단.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
