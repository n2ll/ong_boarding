import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";

/**
 * Ongboarding UI System — Input
 * MASTER.md §3:
 * - placeholder를 label 대신 쓰지 않는다.
 * - label / hint / error를 htmlFor · aria-describedby · aria-invalid로 연결한다.
 * - 오류는 필드 바로 아래에 표시한다.
 *
 * `label`을 넘기면 라벨·힌트·오류가 함께 렌더된다. 라벨을 화면 밖 다른 곳에서
 * 이미 그리고 있다면 label을 생략하고 `aria-label`을 직접 넘긴다.
 */
const inputVariants = cva(
  "flex w-full rounded-2xl border font-medium outline-none transition-[background-color,border-color,box-shadow] duration-200 placeholder:text-muted-foreground/75 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-surface-raised border-border-strong text-foreground hover:border-gray-300 shadow-[var(--shadow-inset)]",
        glass:
          "bg-white/55 border-white/75 text-foreground hover:bg-white/75 focus:bg-white backdrop-blur-md shadow-[var(--shadow-inset)]",
        ghost:
          "bg-transparent border-transparent text-foreground hover:bg-black/[0.03] focus:bg-white/75",
      },
      inputSize: {
        sm: "h-9 px-3 text-xs",
        default: "h-11 px-4 text-sm",
        lg: "h-14 px-5 text-base rounded-2xl",
      },
    },
    defaultVariants: {
      variant: "default",
      inputSize: "default",
    },
  },
);

type InputProps = Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants> & {
    label?: string;
    hint?: string;
    error?: string;
  };

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, variant, inputSize, label, hint, error, id, ...props },
  ref,
) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const describedById = hint || error ? `${inputId}-description` : undefined;

  const field = (
    <input
      ref={ref}
      id={inputId}
      data-slot="input"
      aria-invalid={error ? true : undefined}
      aria-describedby={describedById}
      className={cn(inputVariants({ variant, inputSize, className }))}
      {...props}
    />
  );

  if (!label && !hint && !error) return field;

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={inputId}
          className="mb-1.5 block text-[13px] font-bold text-foreground"
        >
          {label}
        </label>
      )}
      {field}
      {(error || hint) && (
        <p
          id={describedById}
          className={cn(
            "mt-1.5 text-[12px] font-medium",
            error ? "text-error-strong" : "text-muted-foreground",
          )}
        >
          {error || hint}
        </p>
      )}
    </div>
  );
});

export { Input, inputVariants };
