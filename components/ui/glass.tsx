import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";

/**
 * Ongboarding UI System — Glass surface
 *
 * 재질 판정(2026-08-18 로드맵 확정): 그 면이 fixed/sticky/포탈로 떠서 스크롤 시
 * 콘텐츠가 밑을 지나가는가? YES → 유리 레벨(2/3/dark). NO(스크롤과 함께 움직이는
 * in-flow 면) → 콘텐츠 레벨(card/warm/cool — 불투명·무블러). 애매하면 스크롤해 보라.
 *
 * - level 2:    셸 크롬(탑바급) — 유리 중 가장 투명한 허용선(0.68)
 * - level 3:    밝은 오버레이(모달·패널·⌘K) — 텍스트 많은 면의 하한(0.9)
 * - level dark: 어두운 크롬(독·선택 액션바·툴팁)
 * - level card: 콘텐츠 표준 시트(불투명 웜톤) — 본문 카드의 정본
 * - level warm/cool: 존 틴트 — 대시보드 큐 카드 파일럿 한정.
 *   warm=긴급(SOS·실패), cool=대기 큐. 항상 라벨·아이콘 동반(색만으로 상태 전달 금지).
 *
 * 규칙
 * - 대비가 부족하면 투명도를 낮추지 말고 불투명 card를 고른다(MASTER.md §2).
 * - 유리 레벨은 overflow-hidden이라 absolute 자식(드롭다운·팝오버·데이트피커)을 자른다 —
 *   그런 면은 이 컴포넌트 대신 `.glass`/`.glass-dark` 유틸 + `backdrop-blur-*` 조합을 쓸 것
 *   (Topbar가 그렇게 한다). 콘텐츠 레벨은 overflow를 건드리지 않으므로 안전하다.
 * - map으로 반복 렌더되는 카드·테이블 행에 유리 레벨 금지 — 블러 레이어가 행 수만큼 쌓여
 *   스크롤 프레임을 깎는다(칸반 300장 실측). 반복 요소는 card/warm/cool만.
 * - level 1(0.52)은 2026-08-18 퇴역 — 한국어 본문 대비 하한(0.68) 미달이라 쓸 곳이 없다.
 *   --glass-1 토큰 값은 남아 있지만 새 사용처를 만들지 말 것.
 */
const glassVariants = cva(
  "relative transition-shadow duration-300",
  {
    variants: {
      level: {
        2: "overflow-hidden bg-glass-2 backdrop-blur-lg backdrop-saturate-150 border border-border-glass shadow-[var(--shadow-glass-sm)]",
        3: "overflow-hidden bg-glass-3 backdrop-blur-xl backdrop-saturate-150 border border-border-glass shadow-[var(--shadow-glass-xl)]",
        dark: "overflow-hidden bg-glass-dark backdrop-blur-xl backdrop-saturate-150 border border-white/10 shadow-[var(--shadow-glass-dark)] text-white",
        card: "bg-card border border-border-strong shadow-[var(--shadow-xs)]",
        warm: "bg-zone-warm border border-border-strong shadow-[var(--shadow-xs)]",
        cool: "bg-zone-cool border border-border-strong shadow-[var(--shadow-xs)]",
      },
      radius: {
        md: "rounded-md",
        lg: "rounded-lg",
        xl: "rounded-xl",
        "2xl": "rounded-2xl",
      },
      interactive: {
        true: "hover:shadow-[var(--shadow-md)] hover:-translate-y-0.5 motion-reduce:transform-none cursor-pointer",
        false: "",
      },
    },
    defaultVariants: {
      level: "card",
      radius: "2xl",
      interactive: false,
    },
  },
);

type GlassProps = React.ComponentProps<"div"> &
  VariantProps<typeof glassVariants>;

function Glass({ className, level, radius, interactive, children, ...props }: GlassProps) {
  return (
    <div
      data-slot="glass"
      className={cn(glassVariants({ level, radius, interactive, className }))}
      {...props}
    >
      {children}
    </div>
  );
}

export { Glass, glassVariants };
