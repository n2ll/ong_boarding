import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";

/**
 * Ongboarding UI System — Badge
 * MASTER.md §1: 상태는 색만으로 전달하지 않는다. 배지 안의 글자가 상태를
 * 말하고 색은 거들기만 한다. 색만 다르고 글자가 같은 배지를 만들지 말 것.
 */
const badgeVariants = cva(
  "inline-flex items-center justify-center gap-1 w-fit shrink-0 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-bold transition-colors overflow-hidden [&>svg]:size-3 [&>svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-muted text-gray-700 border-border-strong",
        brand: "bg-brand-muted text-warning-strong border-yellow-200",
        success: "bg-success-soft text-success-strong border-success/25",
        info: "bg-info-soft text-info-strong border-info/25",
        warning: "bg-warning-soft text-warning-strong border-warning/35",
        error: "bg-error-soft text-error-strong border-error/30",
        copilot: "bg-copilot-soft text-copilot-strong border-copilot/30",
        solid: "bg-primary text-primary-foreground border-transparent",
        glass: "bg-white/40 text-gray-700 border-white/50 backdrop-blur-sm",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean };

// asChild를 노출하므로 Button과 같은 이유로 forwardRef여야 한다.
const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant, asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      ref={ref}
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
});

export { Badge, badgeVariants };
