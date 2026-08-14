"use client";

import * as React from "react";

import { cn } from "./utils";

/**
 * Ongboarding UI System — Field
 *
 * 이 제품의 입력란은 141곳이 전부 raw <input>/<select>/<textarea>였고,
 * 파일마다 아래 6줄짜리 클래스 문자열을 손으로 복사해 쓰고 있었다:
 *   "min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-sm
 *    focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
 *
 * 복사본이라 아래가 전부 제각각이었다:
 *  - `focus:`를 써서 마우스로 눌러도 테두리가 번쩍였다(키보드용 `focus-visible:`이 맞다).
 *  - 포커스 링이 브랜드 옐로였는데, 밝은 배경 위 옐로는 대비가 안 나온다.
 *  - 라벨이 <label htmlFor>로 연결되지 않은 곳이 많아, 라벨을 눌러도 칸이 잡히지 않았다.
 *  - 필수 표시(*)가 별표 글자일 뿐이라 스크린리더에는 안 들렸다.
 *  - 오류를 띄울 자리가 없어서 저장 실패는 토스트로만 알렸다.
 *    (어느 칸이 틀렸는지 사용자가 찾아야 했다.)
 *
 * 여기서 한 벌로 정하고, 라벨·힌트·오류·필수 여부를 전부 접근성 속성으로 연결한다.
 */

/** 모든 입력 컨트롤이 공유하는 표면. 유리 면 위에서도 흰 카드 위에서도 같은 무게로 읽힌다. */
export const controlBase =
  "w-full rounded-xl border border-border-strong bg-input-background/90 px-3.5 text-[14px] font-medium text-foreground shadow-[var(--shadow-inset)] outline-none transition-[background-color,border-color,box-shadow] duration-150 placeholder:font-normal placeholder:text-muted-foreground/70 hover:border-foreground/25 focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-55 aria-[invalid=true]:border-error aria-[invalid=true]:focus-visible:ring-error";

const CONTROL_H = "min-h-11 py-2.5";

type FieldShellProps = {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  /** 라벨 오른쪽 끝에 붙는 보조 요소(글자 수, 되돌리기 링크 등). */
  aside?: React.ReactNode;
  className?: string;
  /** 2단 그리드에서 한 줄을 다 쓰고 싶을 때. */
  full?: boolean;
};

type RenderProps = { id: string; describedBy?: string; invalid: boolean };

/**
 * 라벨/힌트/오류 껍데기만 담당한다. 토글·날짜 선택기처럼 <input>이 아닌
 * 컨트롤도 같은 모양으로 감쌀 수 있게 render prop을 받는다.
 */
function Field({
  label,
  hint,
  error,
  required,
  aside,
  className,
  full,
  children,
}: FieldShellProps & { children: React.ReactNode | ((p: RenderProps) => React.ReactNode) }) {
  const id = React.useId();
  const describedBy = error || hint ? `${id}-desc` : undefined;

  return (
    <div className={cn("min-w-0", full && "col-span-full", className)}>
      {label && (
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <label
            htmlFor={id}
            className="block text-[13px] font-bold leading-tight text-foreground"
          >
            {label}
            {required && (
              <span className="ml-0.5 text-error-strong" aria-hidden>
                *
              </span>
            )}
          </label>
          {aside && <span className="shrink-0 text-[11.5px] font-medium text-muted-foreground">{aside}</span>}
        </div>
      )}
      {typeof children === "function"
        ? children({ id, describedBy, invalid: Boolean(error) })
        : children}
      {(error || hint) && (
        <p
          id={describedBy}
          className={cn(
            "mt-1.5 text-[12px] font-medium leading-relaxed",
            error ? "text-error-strong" : "text-muted-foreground",
          )}
        >
          {error || hint}
        </p>
      )}
    </div>
  );
}

type Common = FieldShellProps & { required?: boolean };

const TextField = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "className"> & Common & { inputClassName?: string }
>(function TextField(
  { label, hint, error, required, aside, className, full, inputClassName, ...props },
  ref,
) {
  return (
    <Field {...{ label, hint, error, required, aside, className, full }}>
      {({ id, describedBy, invalid }) => (
        <input
          ref={ref}
          id={id}
          required={required}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cn(controlBase, CONTROL_H, inputClassName)}
          {...props}
        />
      )}
    </Field>
  );
});

const TextareaField = React.forwardRef<
  HTMLTextAreaElement,
  Omit<React.ComponentProps<"textarea">, "className"> & Common & { inputClassName?: string }
>(function TextareaField(
  { label, hint, error, required, aside, className, full, inputClassName, rows = 3, ...props },
  ref,
) {
  return (
    <Field {...{ label, hint, error, required, aside, className, full }}>
      {({ id, describedBy, invalid }) => (
        <textarea
          ref={ref}
          id={id}
          rows={rows}
          required={required}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cn(controlBase, "resize-y py-2.5 leading-relaxed", inputClassName)}
          {...props}
        />
      )}
    </Field>
  );
});

/**
 * 네이티브 <select>를 유지한다 — 모바일에서 OS 기본 선택기가 뜨는 게
 * 커스텀 드롭다운보다 빠르고, 시니어 사용자에게도 익숙하다.
 * 화살표는 theme.css의 `select` 규칙이 그린다(`pr-8`이 필요한 이유).
 */
const SelectField = React.forwardRef<
  HTMLSelectElement,
  Omit<React.ComponentProps<"select">, "className"> & Common & { inputClassName?: string }
>(function SelectField(
  { label, hint, error, required, aside, className, full, inputClassName, children, ...props },
  ref,
) {
  return (
    <Field {...{ label, hint, error, required, aside, className, full }}>
      {({ id, describedBy, invalid }) => (
        <select
          ref={ref}
          id={id}
          required={required}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cn(controlBase, CONTROL_H, "cursor-pointer pr-8", inputClassName)}
          {...props}
        >
          {children}
        </select>
      )}
    </Field>
  );
});

/**
 * 켜고 끄는 설정 한 줄. 제품 곳곳에 "테두리 상자 + 제목 + 설명 + 토글" 조합이
 * 손으로 9번 다시 그려져 있었고, 스위치 크기·색·포커스 링이 조금씩 달랐다.
 *
 * 상자 전체가 눌린다 — 시니어 사용자에게 24px짜리 토글만 노리게 하지 않는다.
 */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  className,
  full,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
  full?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex min-h-[3.25rem] w-full items-center justify-between gap-3 rounded-xl border border-border-strong bg-input-background/70 px-3.5 py-2.5 text-left outline-none transition-colors hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-55",
        full && "col-span-full",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-[13.5px] font-bold leading-tight text-foreground">{label}</span>
        {description && (
          <span className="mt-0.5 block text-[11.5px] font-medium leading-snug text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      <span
        aria-hidden
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors",
          checked ? "bg-success" : "bg-foreground/20",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-5 rounded-full bg-white shadow-[var(--shadow-xs)] transition-transform motion-reduce:transition-none",
            checked ? "translate-x-[1.375rem]" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

export { Field, TextField, TextareaField, SelectField, ToggleRow };
