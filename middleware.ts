import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * 어드민 표면 보호 (I-2, Supabase Auth 로그인 — Basic Auth 클린 컷).
 *
 * `/(admin)` 대시보드 페이지 + `/api/admin/*`(cron 제외)를 Supabase 세션(쿠키)으로 보호한다.
 * 미인증: 페이지 → /login?next=… 리다이렉트, API → 401 JSON.
 * 공개로 둬야 하는 경로(지원 폼·공개 API·인입 웹훅·머신 cron·/login)는 통과시킨다.
 *
 * 쿠키 갱신 규칙(@supabase/ssr 표준): setAll에서 request·response **양쪽**에 기록해야 한다 —
 * 어기면 세션 갱신이 유실돼 로그아웃 루프가 생긴다.
 *
 * 프로덕션에서 Supabase env 미설정 시 fail-closed(503). 개발 환경은 통과(로컬 편의).
 * 계정 정책: Supabase 대시보드에서 신규 가입 차단 + 공용 계정만 발급(파일럿 — 감사추적 없음 수용).
 *
 * 참고: `/api/agent/*`, `/api/messages/*` 등 비-admin API는 이 미들웨어 범위 밖이다(별도 처리 —
 * SMS 게이트웨이 인입 등 머신 콜러가 있어 세션을 요구하면 안 된다).
 */

// 공개(비보호) 경로 — 지원자·SMS Gateway·Vercel cron이 접근.
const PUBLIC_API_PREFIXES = [
  "/api/apply",
  "/api/webhooks",
  "/api/branches",
  "/api/pool", // pull 채널 — 지원자별 무로그인 토큰(access_token)으로 자체 식별
  "/api/admin/cron", // 머신 트리거 — 자체 Bearer(CRON_SECRET)로 인증
];

export async function middleware(req: NextRequest) {
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
    // 페이지: 지원 폼 + 맞춤 공고(pull 링크) + 로그인만 공개, 나머지(어드민 루트 포함) 보호.
    if (
      pathname === "/apply" || pathname.startsWith("/apply/") ||
      pathname === "/p" || pathname.startsWith("/p/") ||
      pathname === "/login"
    ) {
      return NextResponse.next();
    }
  }

  // 여기 도달 = 보호 대상.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { error: "admin auth not configured (Supabase env 미설정)" },
        { status: 503 }
      );
    }
    return NextResponse.next(); // 개발 환경 편의
  }

  // 세션 검증 — 갱신된 쿠키를 request·response 양쪽에 기록(표준 패턴, 어기면 로그아웃 루프).
  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        cookiesToSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = `?next=${encodeURIComponent(pathname + (req.nextUrl.search || ""))}`;
    return NextResponse.redirect(loginUrl);
  }

  return res;
}

export const config = {
  // 정적 자산·Next 내부는 제외하고 나머지는 미들웨어 함수에서 판단.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
