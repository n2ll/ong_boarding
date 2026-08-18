"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "./utils";

/**
 * Ongboarding UI System — Modal
 *
 * 이 제품의 모달은 전부 손으로 만들어져 있었다(19곳). 그 결과:
 *  - ESC로 닫히지 않았다. 닫으려면 마우스로 X를 찾아 눌러야 했다.
 *  - 포커스가 갇히지 않아 Tab을 누르면 뒤쪽 화면 버튼으로 새어나갔고,
 *    닫아도 포커스가 원래 자리로 돌아오지 않았다.
 *  - 뒤 화면이 같이 스크롤돼서 모달 안에서 휠을 굴리면 배경이 밀렸다.
 *  - 스크린리더에 '대화상자'라고 알려주지 않았다(role/aria-modal 없음).
 *  - 어두운 막 색이 파일마다 달랐다(black/30 · foreground/50 · black/50 · 없음).
 *  - 좁은 화면에서 가운데 카드로 떠서 위아래가 잘렸다.
 *
 * 위 6가지는 취향이 아니라 전부 '못 쓰는' 축에 든다. Radix Dialog가
 * ESC·포커스 트랩·포커스 복귀·스크롤 잠금·aria를 이미 해결하므로
 * 다시 만들지 않고 그 위에 이 제품의 표면 규칙만 입힌다.
 *
 * 좁은 화면(<640px)에서는 가운데 카드가 아니라 아래에서 올라오는 시트로 바뀐다.
 * 손이 닿는 곳에 버튼이 오고, 세로로 잘리지 않는다.
 *
 * 쓰는 법 — 기존 `{form && <div className="fixed inset-0 …">}` 패턴을 그대로 옮긴다:
 *   <Modal open={!!form} onClose={() => setForm(null)} title="화주사 편집"
 *          busy={saving} size="lg" footer={<>…</>}>
 *     …본문…
 *   </Modal>
 */

const SIZE = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-4xl",
  full: "sm:max-w-6xl",
} as const;

type ModalProps = {
  open: boolean;
  /** 배경 클릭·ESC·X 어느 쪽으로 닫아도 이 함수가 불린다. */
  onClose: () => void;
  title: React.ReactNode;
  /** 제목 아래 한 줄 설명. 넣으면 스크린리더의 대화상자 설명으로도 연결된다. */
  description?: React.ReactNode;
  /** 저장 중처럼 닫히면 안 되는 동안 true. ESC·배경클릭·X가 모두 잠긴다. */
  busy?: boolean;
  /**
   * 긴 편집 폼은 false로 둔다. 배경을 잘못 한 번 눌러 수정분이 소리 없이 날아가던
   * 문제가 실제로 있었다(공고 수정 모달). ESC는 의도적인 동작이므로 계속 열어 둔다 —
   * 막는 건 '실수로 눌린 배경'뿐이다.
   */
  closeOnOutside?: boolean;
  size?: keyof typeof SIZE;
  /** 아래에 고정되는 액션 줄. 본문이 길어도 항상 보인다. */
  footer?: React.ReactNode;
  /** 헤더 오른쪽, 닫기 버튼 왼쪽에 들어가는 보조 요소. */
  headerAside?: React.ReactNode;
  className?: string;
  /** 본문 패딩을 직접 잡고 싶을 때(표·리스트 모달 등). */
  bodyClassName?: string;
  /**
   * 머리말/본문/바닥 틀 없이 유리 면과 동작(ESC·포커스 트랩·스크롤 잠금·모바일 시트)만 준다.
   * 이미 제 머리말과 바닥을 갖춘 큰 폼(공고 등록·수정 등)을 옮길 때 쓴다 —
   * 안쪽을 건드리지 않고 껍데기만 바꾸기 위한 문이다.
   * 이 모드에서도 `title`은 반드시 넘긴다(화면에는 안 보이고 스크린리더만 읽는다).
   */
  bare?: boolean;
  children: React.ReactNode;
};

function Modal({
  open,
  onClose,
  title,
  description,
  busy = false,
  closeOnOutside = true,
  size = "md",
  footer,
  headerAside,
  className,
  bodyClassName,
  bare = false,
  children,
}: ModalProps) {
  const guardEsc = React.useCallback(
    (e: Event) => {
      if (busy) e.preventDefault();
    },
    [busy],
  );
  const guardOutside = React.useCallback(
    (e: Event) => {
      if (busy || !closeOnOutside) e.preventDefault();
    },
    [busy, closeOnOutside],
  );

  /**
   * 닫은 뒤 포커스를 원래 자리로 돌려놓는다.
   *
   * Radix는 <DialogTrigger>를 쓸 때만 복귀시킨다 — 이 제품은 전부 `open`을 직접
   * 제어하는 구조(트리거 컴포넌트가 없다)라, Radix가 돌아갈 곳을 몰라 포커스가
   * <body>로 떨어졌다. 키보드로 '등록' 버튼을 누른 사람은 창을 닫는 순간 위치를
   * 잃고 Tab을 처음부터 다시 눌러야 했다. 열릴 때 누가 포커스를 갖고 있었는지
   * 우리가 기억해 두고, 닫힐 때 그 자리로 돌려준다.
   */
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    // 열려 있는 채로 통째로 언마운트되는 경우(`{state && <Modal …>}` 형태)에는
    // Radix의 onCloseAutoFocus가 아예 불리지 않는다. 그때도 포커스를 되돌린다.
    return () => {
      const target = returnFocusRef.current;
      requestAnimationFrame(() => {
        // 다른 곳이 이미 포커스를 가져갔으면 뺏지 않는다.
        if (document.activeElement === document.body && target?.isConnected) {
          target.focus({ preventScroll: true });
        }
      });
    };
  }, [open]);

  const restoreFocus = React.useCallback((e: Event) => {
    const target = returnFocusRef.current;
    if (target && target.isConnected) {
      e.preventDefault();
      target.focus({ preventScroll: true });
    }
  }, []);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-scrim backdrop-blur-[3px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          onEscapeKeyDown={guardEsc}
          onPointerDownOutside={guardOutside}
          onInteractOutside={guardOutside}
          onCloseAutoFocus={restoreFocus}
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden border shadow-[var(--shadow-glass-xl)] duration-200",
            // 배경이 비쳐 보이는 유리 면. 글자 대비가 필요한 면이라 가장 불투명한 3단계를 쓴다.
            // blur는 2단(크롬 lg·오버레이 xl)으로 고정 — 40px(2xl)은 비용 대비 식별 불가라 폐지.
            "border-border-glass bg-glass-3 backdrop-blur-xl backdrop-saturate-150",
            // 좁은 화면: 아래에서 올라오는 시트
            "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]",
            "data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
            // 넓은 화면: 가운데 카드
            "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100%-3rem)] sm:max-h-[88dvh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:pb-0",
            "sm:data-[state=closed]:slide-out-to-bottom-0 sm:data-[state=open]:slide-in-from-bottom-0 sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95",
            "motion-reduce:animate-none",
            SIZE[size],
            className,
          )}
        >
          {bare ? (
            <>
              <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
              )}
              {children}
            </>
          ) : (
            <>
          {/* 시트 손잡이 — 좁은 화면에서 아래로 쓸어 내릴 수 있는 면임을 보여준다 */}
          <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-foreground/15 sm:hidden" />

          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border-glass px-5 py-4 sm:px-6 sm:py-5">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-[16px] font-extrabold leading-snug text-foreground sm:text-[18px]">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-[13px] font-medium leading-relaxed text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {headerAside}
              <DialogPrimitive.Close
                aria-label="창 닫기"
                disabled={busy}
                className="relative -mr-1 grid size-9 place-items-center rounded-2xl text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-40"
              >
                <X size={18} />
              </DialogPrimitive.Close>
            </div>
          </div>

          <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6", bodyClassName)}>
            {children}
          </div>

          {footer && (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border-glass bg-white/45 px-5 py-3.5 sm:px-6 sm:py-4">
              {footer}
            </div>
          )}
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export { Modal };
