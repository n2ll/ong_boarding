"use client";

import { Suspense } from "react";
import { Jobs } from "@/components/Jobs";
import { PageLoading } from "@/components/ui/page-loading";

export default function Page() {
  return (
    <Suspense fallback={<PageLoading label="채용공고 불러오는 중" />}>
      <Jobs />
    </Suspense>
  );
}
