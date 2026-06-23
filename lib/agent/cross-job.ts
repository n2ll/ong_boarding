/**
 * 멀티-잡 인지(Phase 1) 공통 유틸.
 *
 * 한 지원자가 여러 공고에 동시 진행될 수 있게 되면서(지원→공고 연결, 세그먼트→공고 추가),
 * 한 SMS 대화에서 지원자가 '현재 공고'가 아닌 다른 공고를 물을 수 있다.
 * 이때 에이전트가 현재 공고 정보로 엉뚱하게 답하지 않도록, 다른 진행 공고 목록을
 * 프롬프트에 인지시키고 "다른 공고 얘기면 되묻거나 매니저 인계" 규칙을 덧붙인다.
 *
 * 단일 공고(다른 공고 없음)일 땐 블록·규칙 모두 빈 문자열 → 기존과 완전히 동일하게 동작.
 */

import type { OtherActiveJob } from "./types";

const STAGE_KO: Record<string, string> = {
  exploration: "탐색",
  screening: "스크리닝",
  onboarding: "온보딩",
  active: "근무",
  paused: "매니저 응대",
};

/** user 프롬프트에 넣을 "다른 진행 공고" 블록. 없으면 빈 문자열. */
export function formatOtherActiveJobs(jobs?: OtherActiveJob[]): string {
  if (!jobs || jobs.length === 0) return "";
  const lines = jobs
    .map(
      (j) =>
        `- [공고 #${j.job_id}] ${j.title}${j.branch ? ` (${j.branch})` : ""} — 진행단계: ${
          STAGE_KO[j.stage] ?? j.stage
        }`
    )
    .join("\n");
  return `\n[이 지원자가 동시에 진행 중인 다른 공고]\n${lines}\n`;
}

/**
 * 시스템 프롬프트에 덧붙일 멀티-잡 인지 규칙.
 * otherActiveJobs가 있을 때만 append 한다(없으면 빈 문자열 → 단일 공고 동작 무변경).
 */
export const CROSS_JOB_RULE = `
## 멀티-잡 인지 — 이 지원자는 다른 공고도 동시에 진행 중이다
아래 [이 지원자가 동시에 진행 중인 다른 공고] 목록이 있으면, 지원자가 그 중 다른 공고를 언급/질문할 수 있다는 점을 항상 염두에 둬라.
- 지원자 메시지가 명백히 **다른 공고**(다른 지점·다른 직무)에 관한 것이면, [현재 공고] 정보로 답하지 마라. 엉뚱한 공고 안내는 치명적이다.
- 어느 공고를 말하는지 **불명확하면** 정중히 되물어 확인하라. 예: "혹시 ○○ 건 말씀이실까요? 확인하고 안내드릴게요."
- 다른 공고의 구체 조건(단가·근무시간·시작일 등)은 이 컨텍스트에 없으니 **추측하지 말고** transition: pause 로 매니저에게 인계하라.
- 메시지가 [현재 공고]에 관한 것이면 평소대로 진행하라.
- ⚠️ 여러 공고가 있다고 해서 "여러 군데 다 가능하세요" 같이 동시 확정/배정을 암시하지 마라. 각 공고는 별개 절차다.
`;

/** otherActiveJobs 유무에 따라 CROSS_JOB_RULE을 붙인 system suffix를 반환. */
export function crossJobSystemSuffix(jobs?: OtherActiveJob[]): string {
  return jobs && jobs.length > 0 ? CROSS_JOB_RULE : "";
}
