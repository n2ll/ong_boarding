import type { Metadata } from "next";

// 지원자 대면 경로 — 브라우저 탭/공유 제목을 '옹고잉'으로 (루트의 '옹보딩'은 어드민 전용).
export const metadata: Metadata = {
  title: "옹고잉 배송원 지원",
};

export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
