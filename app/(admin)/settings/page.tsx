"use client";

import { Suspense } from "react";
import { Settings } from "@/components/Settings";

export default function Page() {
  return (
    <Suspense fallback={<div className="p-8"><div className="h-48 animate-pulse rounded-2xl border border-border bg-muted/60" /></div>}>
      <Settings />
    </Suspense>
  );
}
