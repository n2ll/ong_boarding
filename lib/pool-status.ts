/**
 * 지원자 화면 카드 상황 배지 — "이 자리, 나 어디까지 했더라"를 카드가 답한다.
 *
 * 지금까지는 관심을 누른 모든 공고가 똑같이 후속 연락을 약속했다.
 * 공고 7개가 동시에 열리면 이 한 문장이 셋 다 거짓이 된다: 이미 이야기 중인 자리에도,
 * 보류된 자리에도, 종료된 자리에도 같은 연락 약속이 붙는다.
 *
 * ⚠️ 문구 금지어 — 어떤 상태 라벨에도 다음 단어·뉘앙스를 넣지 않는다(AGENTS.md 절대 규칙):
 *    '확정' '배정' '합격' '출근' '시작하세요' — 관심·대화는 확정이 아니다. 확정은 매니저가 한다.
 * ⚠️ 보류(paused)·종료(ended) 상태에는 **연락 약속 문구를 넣지 않는다** — 보류는 매니저 판단 대기라
 *    시점을 약속할 수 없고, 종료 건에 "연락드릴게요"가 남아 있으면 오지 않는 연락을 기다리게 만든다.
 */

/** 지원자↔공고 한 쌍의 상황. 서버(pool GET)가 job_candidates.agent_stage에서 계산해 내린다. */
export type PoolJobStatus =
  | "none" // 아무 이력 없음 — 기본 카드
  | "interested" // 관심 접수됨(아직 대화 전) — 관심 큐에서 매니저가 컨택한다
  | "talking" // AI·매니저와 이 공고로 대화가 진행 중
  | "paused" // 매니저 확인 대기(인계) — 시점 약속 금지
  | "ended"; // 이 공고 건은 종료(abort) — 다시 관심을 누르면 재접수된다(서버 resurface)

const ACTIVE_STAGES = new Set(["exploration", "screening", "onboarding", "active"]);

/** job_candidates 행(있으면 agent_stage 포함) → 상태. 행이 없으면 none. */
export function poolJobStatus(hasLink: boolean, stage: string | null | undefined): PoolJobStatus {
  if (!hasLink) return "none";
  if (stage && ACTIVE_STAGES.has(stage)) return "talking";
  if (stage === "paused") return "paused";
  if (stage === "abort") return "ended";
  return "interested"; // stage NULL = 관심만 누른 상태(관심 큐)
}

/** 접수 완료 버튼 자리에 들어가는 상태 문장 — 금지어 규칙(위) 준수. */
export const POOL_STATUS_DONE_LABEL: Record<Exclude<PoolJobStatus, "none" | "ended">, string> = {
  interested: "관심이 전달됐어요 — 매니저 검토 목록에 표시됩니다",
  talking: "이 자리로 이야기하고 있어요",
  // 보류 — 연락 약속 없이 사실만. '확인 중'은 활동 서술이지 확정·시점 약속이 아니다.
  paused: "접수됐어요 — 매니저가 확인하고 있어요",
};
