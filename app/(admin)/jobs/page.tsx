"use client";

import { Suspense } from "react";
import { Jobs } from "@/components/Jobs";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Jobs />
    </Suspense>
  );
}
