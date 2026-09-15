export const REPLY_COMPLETED_EVENT = "reply_completed";

export interface ReplyActionPreview {
  direction: string;
  reply_completed?: boolean;
  handoff_required?: boolean;
}

/** 답장과 인계는 하나의 작업만 노출한다. 구형 응답의 미확인 상태는 미답으로 남긴다. */
export function isReplyActionable(preview: ReplyActionPreview | null | undefined): boolean {
  return preview?.direction === "inbound"
    && preview.reply_completed !== true
    && preview.handoff_required !== true;
}
