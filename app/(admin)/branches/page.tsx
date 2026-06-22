"use client";

import { Suspense } from "react";
import { Branches } from "@/components/Branches";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Branches />
    </Suspense>
  );
}
