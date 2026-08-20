"use client";

import { Suspense } from "react";
import { Branches } from "@/components/Branches";
import { PageLoading } from "@/components/ui/page-loading";

export default function Page() {
  return (
    <Suspense fallback={<PageLoading label="지점 관리 불러오는 중" />}>
      <Branches />
    </Suspense>
  );
}
