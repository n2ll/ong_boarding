import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "옹보딩",
  description: "시니어 채용 운영 플랫폼",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
