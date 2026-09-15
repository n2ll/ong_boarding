export const REPLY_COMPLETED_EVENT = "reply_completed";

export type ReplyMessageId = string | number;

/** 운영 messages.id는 UUID다. 기존 정수 ID는 변환 없이 호환한다. */
export function isReplyMessageId(value: unknown): value is ReplyMessageId {
  return typeof value === "string"
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    : typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

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
