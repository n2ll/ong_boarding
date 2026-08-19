import type { Metadata } from "next";

/**
 * 토큰 페이지 메타 — 지원자 여정의 진짜 첫 화면은 문자 속 링크 미리보기다.
 * OG가 없으면 밋밋한 URL만 보인다(iMessage·카카오톡 미리보기).
 *
 * - 이름 등 개인정보는 절대 메타에 넣지 않는다 — 미리보기는 잠금화면·알림에도 뜬다.
 * - noindex는 루트 레이아웃이 전역 적용하지만, 본인 전용 링크라 여기서도 명시해 둔다.
 * - metadataBase: 커스텀 도메인 도입 시 이 한 줄만 바꾼다(없으면 OG 이미지가 상대경로로 나가
 *   미리보기 스크레이퍼가 못 읽는다).
 */
export const metadata: Metadata = {
  metadataBase: new URL("https://ong-boarding-pi.vercel.app"),
  title: "옹고잉 — 맞춤 일자리",
  description: "지금 모집 중인 일자리를 확인하고, 마음에 들면 관심을 남겨주세요. 근무 확정은 매니저 안내 후 진행됩니다.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "옹고잉 — 맞춤 일자리 안내",
    description: "받으신 본인 전용 링크에서 지금 모집 중인 일자리를 확인하세요.",
    type: "website",
    images: [{ url: "/og-pool.png", width: 1200, height: 630 }],
  },
};

export default function PoolLayout({ children }: { children: React.ReactNode }) {
  return children;
}
