import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createBrowserClient } from "@supabase/ssr";

// 서버용 (API route에서 사용 — service_role 키로 RLS 우회)
// Next.js 14 Data Cache가 Supabase JS 내부 fetch를 캐싱하지 못하도록 강제 no-store
export function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, cache: "no-store" }),
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
}

// 로그인용 브라우저 싱글톤 (I-2) — 쿠키 기반 세션(@supabase/ssr)이라 미들웨어가 같은 세션을 읽는다.
// 기존 getBrowserClient(Realtime 전용, 세션 없음)와 별개 — 용도 혼용 금지.
let _authBrowserClient: SupabaseClient | null = null;
export function getAuthBrowserClient(): SupabaseClient {
  if (typeof window === "undefined") {
    throw new Error("getAuthBrowserClient must be called on the client");
  }
  if (!_authBrowserClient) {
    _authBrowserClient = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return _authBrowserClient;
}

// 브라우저용 싱글톤 (Realtime 구독에 사용 — anon key + RLS read policy)
let _browserClient: SupabaseClient | null = null;
export function getBrowserClient(): SupabaseClient {
  if (typeof window === "undefined") {
    throw new Error("getBrowserClient must be called on the client");
  }
  if (!_browserClient) {
    _browserClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        realtime: { params: { eventsPerSecond: 10 } },
      }
    );
  }
  return _browserClient;
}
