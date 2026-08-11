import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";

/**
 * Ongboarding UI System — Glass surface
 * MASTER.md §2: 글래스는 세 단계만 쓴다. 배경 대비가 부족하면 투명도를
 * 낮추지 말고 불투명 surface(`bg-card`)를 고른다.
 *
 * - level 1: 셸 위에 얹는 가벼운 패널
 * - level 2: 기본 카드 (기본값)
 * - level 3: 모달처럼 아래를 확실히 가려야 하는 면
 * - level dark: 툴팁·다크 패널
 */
const glassVariants = cva(
  "relative overflow-hidden transition-shadow duration-300",
  {
    variants: {
      level: {
        1: "bg-glass-1 backdrop-blur-md border border-border-glass shadow-[var(--shadow-xs)]",
        2: "bg-glass-2 backdrop-blur-lg border border-border-glass shadow-[var(--shadow-sm)]",
        3: "bg-glass-3 backdrop-blur-xl border border-white shadow-[var(--shadow-xl)]",
        dark: "bg-glass-dark backdrop-blur-xl border border-white/10 shadow-[var(--shadow-xl)] text-white",
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
      level: 2,
      radius: "xl",
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
