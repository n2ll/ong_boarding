"use client";

import { Suspense } from "react";
import { LiveConsole } from "@/components/LiveConsole";

export default function Page() {
  // LiveConsole이 useSearchParams(?tab= 딥링크)를 쓰므로 Suspense 경계가 필요하다(App Router 요구사항).
  // 이 경계 때문에 하드 로드 첫 페인트에는 프리렌더된 콘솔 셸 대신 아래 fallback이 나온다 —
  // 한 줄짜리 로딩이면 레이아웃이 튀므로 좌·중·우 3분할 골격을 흉내 내 점프를 줄인다.
  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-[480px] w-full animate-pulse">
          <div className="w-[320px] shrink-0 border-r border-border-strong bg-white p-3">
            <div className="h-9 rounded-lg bg-muted mb-3" />
            <div className="h-8 rounded-lg bg-muted mb-2" />
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-16 rounded-2xl bg-background mb-2" />)}
          </div>
          {/* 우측 340px 상세 레일은 대화를 고른 뒤에만 렌더된다 — fallback에서 미리 그리면
              하이드레이션 직후 사라지며 오히려 폭 점프가 생긴다. 좌측 목록 + 중앙만 흉내 낸다. */}
          <div className="flex-1 bg-muted" />
        </div>
      }
    >
      <LiveConsole />
    </Suspense>
  );
}
