export type CandidateClosureKind = "hold" | "disqualify";

export interface CandidateClosureAction {
  confirm: {
    title: string;
    description: string;
    confirmText: string;
    destructive?: boolean;
  };
  mutation: { agent_stage: "abort"; closed_reason: string };
  successMessage: string;
}

export function candidateClosureAction(
  kind: CandidateClosureKind,
  candidateName: string,
): CandidateClosureAction {
  if (kind === "hold") {
    return {
      confirm: {
        title: `${candidateName}님을 이 공고에서 보류할까요?`,
        description: "이 공고의 진행만 멈춥니다. 인력풀에는 유지되며, 필요하면 후보 카드에서 다시 되살릴 수 있어요.",
        confirmText: "보류",
      },
      mutation: { agent_stage: "abort", closed_reason: "manager: 보류" },
      successMessage: "이 공고 보류했어요 (인력풀에는 유지)",
    };
  }

  return {
    confirm: {
      title: `${candidateName}님을 이 공고에서 부적합 처리할까요?`,
      description: "이 공고에서만 후보 진행을 종료합니다. 인력풀에는 유지되어 다른 공고 검토 대상에서는 사라지지 않아요.",
      confirmText: "공고부적합",
      destructive: true,
    },
    mutation: { agent_stage: "abort", closed_reason: "manager: 공고부적합" },
    successMessage: "이 공고 부적합 처리했어요 (인력풀에는 유지)",
  };
}
