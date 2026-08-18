import * as React from "react";

import { cn } from "./utils";

/**
 * 카드형 화면 공용 스캐폴드.
 *
 * - 스크롤은 셸의 main(#app-content) 하나가 소유한다 — 화면이 자체로
 *   h-full/overflow-y-auto를 만들면 스크롤바가 화면마다 달라지고
 *   scrollbar-custom을 못 탄다(예전 Reports·Inbox·AgentBrain·Settings).
 * - 섹션 리듬은 gap-6 하나 — 직속 자식에 mb-*·space-y-*를 얹지 말 것.
 * - [&>*]:shrink-0 — flex-col 부모가 자식을 눌러 찌그러뜨리는 레포 고질 방지.
 * - 패딩은 반응형: 375px에서 p-8 고정이 좌우 44px을 낭비하던 것 해소.
 * - 워크벤치 화면(Pipeline·LiveConsole·Automation·ConversationThread)은 대상 아님.
 */
export function PageShell({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-shell"
      className={cn("flex flex-col gap-6 p-4 pb-12 sm:p-6 sm:pb-12 lg:p-8 lg:pb-12 [&>*]:shrink-0", className)}
      {...props}
    >
      {children}
    </div>
  );
}
