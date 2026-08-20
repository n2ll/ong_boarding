export type PipelineAvailabilityTone = "success" | "info" | "muted";

export interface PipelineAvailabilityMeta {
  label: string;
  tone: PipelineAvailabilityTone;
  freshness: string | null;
}

export interface PipelineContactMeta {
  primary: string;
  campaign: string | null;
}

export interface PipelineTableLayout {
  columnCount: number;
  hideSecondaryColumns: boolean;
  minWidthClass: string;
}

function relativeTimeAt(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  const minutes = Math.max(0, Math.floor((nowMs - time) / 60000));
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

export function pipelineAvailabilityMeta(
  value: string | null,
  updatedAt: string | null,
  nowMs: number = Date.now(),
): PipelineAvailabilityMeta {
  const age = relativeTimeAt(updatedAt, nowMs);
  if (value === "즉시가능") return { label: "즉시 가능", tone: "success", freshness: age ? `확인 ${age}` : null };
  if (value === "이번주가능") return { label: "이번 주 가능", tone: "info", freshness: age ? `확인 ${age}` : null };
  if (value === "휴면") return { label: "휴면", tone: "muted", freshness: age ? `확인 ${age}` : null };
  return { label: "미확인", tone: "muted", freshness: null };
}

export function pipelineContactMeta(
  lastReplyAt: string | null,
  lastPingAt: string | null,
  nowMs: number = Date.now(),
): PipelineContactMeta {
  const replyAge = relativeTimeAt(lastReplyAt, nowMs);
  const campaignAge = relativeTimeAt(lastPingAt, nowMs);
  return {
    primary: replyAge ? `지원자 답장 ${replyAge}` : "지원자 답장 없음",
    campaign: campaignAge ? `캠페인 발송 ${campaignAge}` : null,
  };
}

export function pipelineTableLayout(splitPanelActive: boolean): PipelineTableLayout {
  return splitPanelActive
    ? { columnCount: 3, hideSecondaryColumns: true, minWidthClass: "min-w-[500px]" }
    : { columnCount: 7, hideSecondaryColumns: false, minWidthClass: "min-w-[1060px]" };
}
