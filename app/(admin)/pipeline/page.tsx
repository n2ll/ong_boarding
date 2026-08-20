"use client";

import { Suspense } from "react";
import { Pipeline } from "@/components/Pipeline";
import { PageLoading } from "@/components/ui/page-loading";

export default function Page() {
  return (
    <Suspense fallback={<PageLoading label="인재풀 불러오는 중" />}>
      <Pipeline />
    </Suspense>
  );
}
