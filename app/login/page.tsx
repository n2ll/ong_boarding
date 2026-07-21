"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, LogIn } from "lucide-react";
import { getAuthBrowserClient } from "@/lib/supabase";
import { LogoMark } from "@/components/Logo";

/**
 * 어드민 로그인 (I-2) — Supabase Auth 이메일+비밀번호.
 * (admin) 그룹 밖이라 어드민 레이아웃(사이드바 등) 미적용. 성공 시 ?next(기본 /)로 이동.
 * 계정은 Supabase 대시보드에서만 발급(신규 가입 차단) — 파일럿은 공용 계정 1개.
 */

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = getAuthBrowserClient();
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInErr) {
        setError("이메일 또는 비밀번호가 올바르지 않아요.");
        return;
      }
      // 미들웨어가 쿠키 세션을 읽으므로 전체 네비게이션으로 이동(라우터 캐시 우회).
      const next = searchParams.get("next");
      const dest = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      window.location.href = dest;
    } catch {
      setError("로그인에 실패했어요. 잠시 후 다시 시도해주세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-full max-w-[380px] bg-white rounded-2xl border border-[#E2E8F0] shadow-sm p-8 space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-[#1A202C] flex items-center justify-center">
          <LogoMark size={30} />
        </div>
        <div>
          <div className="text-[18px] font-extrabold text-[#1A202C] leading-tight">옹보딩</div>
          <div className="text-[12px] text-[#718096]">관리자 콘솔 로그인</div>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-[12.5px] font-bold text-[#4A5568] mb-1.5">이메일</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            className="w-full px-3.5 py-2.5 border border-[#E2E8F0] rounded-xl text-[14px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
          />
        </div>
        <div>
          <label className="block text-[12.5px] font-bold text-[#4A5568] mb-1.5">비밀번호</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="w-full px-3.5 py-2.5 border border-[#E2E8F0] rounded-xl text-[14px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
          />
        </div>
      </div>

      {error && (
        <div className="px-3.5 py-2.5 rounded-xl bg-[#FFF5F5] border border-[#FEB2B2] text-[12.5px] font-semibold text-[#C53030]">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-[14px] font-bold text-[#1A202C] bg-[#FFCB3C] hover:bg-[#E0B500] disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1A202C]"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
        로그인
      </button>

      <p className="text-[11.5px] text-[#A0AEC0] leading-relaxed">
        계정은 관리자가 발급합니다. 로그인 문제는 팀 채널로 문의해주세요.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F7FAFC] p-4">
      <Suspense fallback={<Loader2 size={22} className="animate-spin text-[#A0AEC0]" />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
