type LogoMarkProps = {
  size?: number;
  className?: string;
};

/**
 * 옹보딩 스마일 아이콘. 다크(눈·입)와 옐로우(미소) 브랜드 컬러는
 * 가이드 고정값을 사용한다(파비콘/SVG 자산과 동일하게 유지하기 위함).
 */
export function LogoMark({ size = 38, className }: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role="img"
      aria-label="옹보딩"
      className={className}
    >
      <circle cx="24" cy="21" r="6" fill="var(--brand-dark, #0F141E)" />
      <circle cx="40" cy="21" r="6" fill="var(--brand-dark, #0F141E)" />
      <path d="M13 32 A19 19 0 0 0 51 32 Z" fill="var(--brand-yellow, #FFC83D)" />
      <path d="M17 30 A15 15 0 0 0 47 30 Z" fill="var(--brand-dark, #0F141E)" />
    </svg>
  );
}
