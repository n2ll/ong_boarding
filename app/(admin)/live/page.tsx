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
          <div className="w-[320px] shrink-0 border-r border-[#E2E8F0] bg-white p-3">
            <div className="h-9 rounded-lg bg-[#EDF2F7] mb-3" />
            <div className="h-8 rounded-lg bg-[#F1F4F8] mb-2" />
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-16 rounded-xl bg-[#F7FAFC] mb-2" />)}
          </div>
          <div className="flex-1 bg-[#EEF1F5]" />
          <div className="w-[340px] shrink-0 border-l border-[#E2E8F0] bg-white" />
        </div>
      }
    >
      <LiveConsole />
    </Suspense>
  );
}
