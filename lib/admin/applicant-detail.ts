export interface ApplicantAttentionMeta {
  label: string;
  description: string;
}

export interface ApplicantConfirmationAction {
  label: string;
  disabled: boolean;
  intent: "confirm" | "undo" | "blocked";
}

export function applicantAttentionMeta(
  stage: string | null,
  reason: string | null,
): ApplicantAttentionMeta | null {
  if (stage !== "paused") return null;
  const description = reason?.trim() || "AI가 응답을 멈춘 대화예요. 대화 내용을 확인하고 직접 답변해 주세요.";
  return { label: "사람 확인 필요", description };
}

export function applicantConfirmationAction(
  status: string,
  confirmableJobCount: number,
): ApplicantConfirmationAction {
  if (status === "확정인력") {
    return { label: "확정 취소", disabled: false, intent: "undo" };
  }
  if (confirmableJobCount < 1) {
    return { label: "확정할 공고 없음", disabled: true, intent: "blocked" };
  }
  return { label: "확정", disabled: false, intent: "confirm" };
}
