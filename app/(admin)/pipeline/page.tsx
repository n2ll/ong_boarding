"use client";

import { Suspense } from "react";
import { Pipeline } from "@/components/Pipeline";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Pipeline />
    </Suspense>
  );
}
