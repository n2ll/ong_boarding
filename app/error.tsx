"use client";

import { useEffect } from "react";

/**
 * 앱 공통 에러 바운더리.
 *
 * 예전엔 이 파일이 없어서, 컴포넌트 하나가 throw하면 그 화면이 **대체 UI 없이 백지**가
 * 됐다(감사 중 실시간 응대 화면 전체가 빈 배경만 남는 것을 확인). 운영 도구에서 백지는
 * "고장"이 아니라 "아무 일도 없음"으로 읽혀 더 위험하다 — 최소한 무엇이 잘못됐고
 * 무엇을 누르면 되는지 말해준다.
 *
 * Next App Router 규약: error.tsx는 같은 세그먼트의 layout까지는 살리고 page 쪽 오류만
 * 감싼다. reset()은 해당 세그먼트를 다시 렌더한다.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // 서버 로그로도 남긴다 — 화면만 복구되고 원인이 증발하지 않게.
    console.error("[app error boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="text-4xl" aria-hidden>⚠️</div>
      <h1 className="text-[20px] font-extrabold text-foreground">화면을 불러오지 못했어요</h1>
      <p className="max-w-md text-[14px] leading-relaxed text-muted-foreground">
        일시적인 오류일 수 있어요. 아래 버튼으로 다시 시도하고, 반복되면 새로고침(⌘R) 후에도
        같은지 확인해 주세요.
        {error.digest && <span className="mt-1 block text-[12px] text-muted-foreground/70">오류 코드: {error.digest}</span>}
      </p>
      <button
        onClick={reset}
        className="min-h-11 rounded-2xl bg-foreground px-5 text-[14px] font-bold text-white outline-none transition-colors hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        다시 시도
      </button>
    </div>
  );
}
