import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "./utils";

/**
 * Ongboarding UI System — Button
 * 계약은 design-system/ongboarding/MASTER.md §3을 따른다.
 *
 * - primary: 제품의 핵심 실행 (Ink)
 * - brand:   AI 추천·검토 등 Signal Yellow가 의미를 가지는 실행
 * - secondary: 대안 행동
 * - ghost:   취소·낮은 우선순위
 * - glass:   앱 셸 위에 뜨는 도구
 * - destructive: 되돌릴 수 없는 파괴적 실행
 *
 * 모든 크기는 최소 44px다(시니어·터치 대응). 아이콘만 있는 버튼은
 * 반드시 `aria-label`을 넘겨야 한다 — 개발 모드에서 경고한다.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-bold shrink-0",
    "transition-[background-color,border-color,color,box-shadow,transform] duration-200",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "active:scale-[0.98] motion-reduce:transform-none",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground hover:bg-gray-800 shadow-action hover:-translate-y-px",
        brand:
          "bg-brand-yellow text-foreground hover:bg-yellow-300 shadow-brand hover:-translate-y-px",
        secondary:
          "bg-surface-raised border border-border-strong text-foreground hover:bg-gray-50 shadow-xs",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        glass:
          "bg-white/55 border border-white/75 text-foreground hover:bg-white/90 backdrop-blur-md shadow-xs",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-error-strong shadow-xs focus-visible:ring-destructive",
      },
      size: {
        sm: "min-h-11 px-3.5 text-xs rounded-2xl",
        default: "min-h-11 px-4 py-2 text-sm rounded-2xl",
        lg: "min-h-12 px-6 text-base rounded-2xl",
        icon: "h-11 w-11 rounded-full",
        /**
         * 44px 규칙의 명시적 예외. 목록 행 안에 여러 개가 나란히 붙는
         * 인라인 액션(재개·보류·부적합처럼 행마다 반복되는 것)에만 쓴다.
         * 44px를 주면 행 높이가 무너져 한 화면에 보이는 후보 수가 줄어든다.
         * 화면의 주요 실행(저장·발송·등록)에는 절대 쓰지 말 것.
         */
        chip: "min-h-7 px-2 py-1 text-[12px] rounded-md gap-1 [&_svg:not([class*='size-'])]:size-3",
        /** 도구 모음의 아이콘+글자 버튼. chip과 같은 취지의 예외. */
        toolbar: "min-h-8 px-2 py-2 text-[12px] rounded-lg gap-1",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** 진행 중 표시. 스피너를 앞에 붙이고 버튼을 잠근다. */
    isLoading?: boolean;
  };

/**
 * forwardRef여야 한다 — Radix의 `asChild`(DropdownMenuTrigger, TooltipTrigger 등)는
 * 자식에 ref를 넘겨 위치 계산과 포커스 복귀를 한다. 일반 함수 컴포넌트로 두면
 * "Function components cannot be given refs" 경고와 함께 메뉴가 엉뚱한 곳에 뜨거나
 * 닫힐 때 포커스가 트리거로 돌아오지 않는다.
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, isLoading = false, disabled, children, ...props },
  ref,
) {
  if (process.env.NODE_ENV !== "production" && size === "icon") {
    if (!props["aria-label"] && !props.title) {
      // eslint-disable-next-line no-console
      console.warn(
        "[Button] size=\"icon\" 버튼에 aria-label 또는 title이 없습니다. 스크린리더가 읽을 이름이 필요합니다.",
        children,
      );
    }
  }

  const resolvedClassName = cn(buttonVariants({ variant, size, className }));

  if (asChild) {
    return (
      <Slot
        ref={ref}
        data-slot="button"
        className={resolvedClassName}
        aria-busy={isLoading || undefined}
        {...props}
      >
        {children}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      data-slot="button"
      className={resolvedClassName}
      disabled={isLoading || disabled}
      aria-busy={isLoading || undefined}
      {...props}
    >
      {isLoading && (
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      )}
      {children}
    </button>
  );
});

export { Button, buttonVariants };
