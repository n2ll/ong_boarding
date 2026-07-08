import type { Metadata } from "next";

// 지원자 대면 경로 — 브라우저 탭/공유 제목을 '옹고잉'(고용주 브랜드)으로.
// 루트 레이아웃의 '옹보딩'(내부 도구명)은 어드민에만 남긴다. robots noindex는 루트에서 상속.
export const metadata: Metadata = {
  title: "옹고잉 · 맞춤 일자리",
};

export default function PoolLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
