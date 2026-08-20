"use client";

import { Suspense } from "react";
import { AgentBrain } from "@/components/AgentBrain";

export default function Page() {
  return (
    <Suspense fallback={<div className="p-8" aria-label="에이전트 두뇌 불러오는 중"><div className="h-40 animate-pulse rounded-2xl border border-border bg-muted/60" /></div>}>
      <AgentBrain />
    </Suspense>
  );
}
