/**
 * 멀티-잡 인지 — 한 대화에서 지원자가 '현재 공고'가 아닌 다른 공고를 물을 때의 처리.
 *
 * 공고 6~7개를 동시에 열면 한 사람이 여러 공고에 붙는 것이 기본 상태가 된다. 그때 대표 사고는
 * **다른 공고 질문에 현재 공고 값으로 답하는 것**이다(단가·근무시간·집결지가 라인마다 다르다).
 *
 * 예전에는 블록에 공고명·진행단계만 실어 주고 "다른 공고 질문이면 무조건 pause"로 막았다.
 * 그러면 안전하긴 하지만, 공고 7개를 동시에 열면 "그 자리 시간대는요?" 같은 흔한 질문마다
 * 매니저 인계가 쌓인다. 그래서 **답할 수 있는 값은 블록에 싣고**, 없는 값은 숨기지 않고
 * **항목명을 '미기재'로 열거**한다 — 빈칸을 감추면 모델이 현재 공고 값으로 메운다.
 *
 * ⚠️ 추측 금지 — 블록에 적힌 값만 인용해 답한다. '미기재' 항목은 pause.
 * ⚠️ 확정 뉘앙스 금지 — 여러 자리를 안내하는 것이 동시 배정·확정을 뜻하지 않는다.
 * ⚠️ 모델 자기신고(`answered_other_job_id`)는 **근거가 아니라 신호**다. 결정적 판단은
 *    `crossJobBackstop`이 코드로 한다(모델이 스스로 지킨다고 믿지 않는다).
 */

import type { OtherActiveJob, StageResult, StageTransition } from "./types";
import { coarseArea } from "../geo";

const STAGE_KO: Record<string, string> = {
  exploration: "탐색",
  screening: "스크리닝",
  onboarding: "온보딩",
  active: "근무",
  paused: "매니저 응대",
};

/** 급여 한 줄 — pay_info 원문이 있으면 그것, 없으면 pay_type/pay_amount 조합. */
function payLine(j: OtherActiveJob): string | null {
  const info = (j.pay_info ?? "").trim();
  if (info) return info;
  if (typeof j.pay_amount === "number" && j.pay_amount > 0) {
    return `${j.pay_type ?? "급여"} ${j.pay_amount.toLocaleString("ko-KR")}원`;
  }
  return null;
}

/** 이 공고에서 '지금 답할 수 있는 항목'과 '미기재 항목'을 가른다. */
export function splitJobFacts(j: OtherActiveJob): { known: [string, string][]; missing: string[] } {
  const rows: [string, string | null][] = [
    ["근무시간", (j.slot ?? "").trim() || null],
    ["근무기간", (j.work_period ?? "").trim() || null],
    ["시작일", (j.start_date ?? "").trim() || null],
    ["급여", payLine(j)],
    // **상세 주소는 싣지 않는다** — 집결지 상세는 확정 후 매니저가 안내하는 값이다.
    // 지원자 카드(/p/[token])와 같은 함수로 '서울 서초구'까지만(lib/geo.coarseArea).
    ["집결지(대략)", coarseArea(j.pickup_address) || null],
    ["본인 차량", j.vehicle_required == null ? null : j.vehicle_required ? "필요" : "필요 없음"],
  ];
  const known: [string, string][] = [];
  const missing: string[] = [];
  for (const [k, v] of rows) {
    if (v) known.push([k, v]);
    else missing.push(k);
  }
  return { known, missing };
}

/**
 * 이 공고에 답할 수 있는 값이 하나도 없나 — 라우터 백스톱의 판단 재료.
 * ⚠️ '본인 차량'은 제외한다 — `jobs.vehicle_required`는 NOT NULL DEFAULT true라 **아무도 입력하지 않아도
 *    항상 값이 있다.** 그걸 근거로 세면 제목만 있는 빈 공고도 '답할 값이 있다'가 되어 이 백스톱이
 *    영원히 발화하지 않는 죽은 코드가 된다(게이트 지적).
 */
export function hasNoAnswerableFacts(j: OtherActiveJob): boolean {
  return splitJobFacts(j).known.filter(([k]) => k !== "본인 차량").length === 0;
}

/** user 프롬프트에 넣을 "다른 진행 공고" 블록. 없으면 빈 문자열. */
export function formatOtherActiveJobs(jobs?: OtherActiveJob[]): string {
  if (!jobs || jobs.length === 0) return "";
  const lines = jobs
    .map((j) => {
      const { known, missing } = splitJobFacts(j);
      const head = `- [공고 #${j.job_id}] ${j.title}${j.branch ? ` (${j.branch})` : ""} — 진행단계: ${
        STAGE_KO[j.stage] ?? j.stage
      }`;
      const facts = known.map(([k, v]) => `  · ${k}: ${v}`);
      // **빈 항목을 이름으로 밝힌다** — 숨기면 모델이 현재 공고 값으로 메운다.
      const gap = missing.length > 0 ? [`  · 미기재(이 공고에 없는 정보 — 절대 추측 금지): ${missing.join(", ")}`] : [];
      return [head, ...facts, ...gap].join("\n");
    })
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
메시지를 처리하기 전에 **먼저 "이 메시지가 어느 공고에 관한 것인가"를 판정**하고, 아래 우선순위대로 행동하라.

1. 메시지가 **다른 공고**의 정보를 묻는데, 그 값이 위 목록에 **적혀 있으면** → 그 값을 **그대로 인용해** 답해도 된다.
   - 적힌 값을 바꾸거나 계산하거나 단위를 환산하지 마라. 없는 값을 현재 공고 값으로 메우는 것은 금지다.
   - 답할 때 어느 자리 이야기인지 밝혀라(예: "용산 자리는 평일 오전이에요").
   - 이때 **answered_other_job_id에 그 공고 번호를, answered_other_job_fields에 인용한 항목명 전부를** 넣어라. transition은 stay.
2. 다른 공고 질문인데 그 항목이 **'미기재'로 표시되어 있거나 목록에 아예 없으면** → **반드시 transition: pause**.
   추측 금지, 현재 공고 값으로 대신 답하지 말고, 현재 공고 질문으로 화제를 돌려 답하지도 마라.
   pause 시 reply_text는 "확인 후 매니저가 안내드릴게요" 정도로 짧게 두고 handoff_category는 cross_job.
3. 어느 공고를 말하는지 **불명확하면** 정중히 되물어 확인하라. 예: "혹시 ○○ 자리 말씀이실까요?" (이때는 pause 아님)
4. 다른 공고를 **스치듯 언급만** 하고 정보를 요구하지 않으면, 짧게 인지만 하고 [현재 공고] 진행을 이어가도 된다.
5. 메시지가 [현재 공고]에 관한 것이면 평소대로 진행하고 answered_other_job_id는 비워라.
- ⚠️ 집결지는 **대략 지역까지만** 안내한다. 상세 주소·화주사명·현장 연락처를 물으면 값이 있어도 답하지 말고 transition: pause(handoff_category: cross_job).
- ⚠️ 다른 공고 이야기를 한 턴은 **현재 공고의 체크리스트를 진전시키지 않는다** — 그 턴에 advance를 고르지 마라.
- ⚠️ 여러 공고가 있다고 해서 "여러 군데 다 가능하세요" 같이 동시 확정/배정을 암시하지 마라. 각 공고는 별개 절차다.
`;

/** otherActiveJobs 유무에 따라 CROSS_JOB_RULE을 붙인 system suffix를 반환. */
export function crossJobSystemSuffix(jobs?: OtherActiveJob[]): string {
  return jobs && jobs.length > 0 ? CROSS_JOB_RULE : "";
}

/** 블록에 실리는 항목명 — tool enum과 백스톱이 같은 이름을 쓴다. */
export const CROSS_JOB_FIELD_NAMES = ["근무시간", "근무기간", "시작일", "급여", "집결지(대략)", "본인 차량"] as const;

/** 각 stage의 *_turn tool input_schema.properties에 그대로 spread. */
export const crossJobToolProperties = {
  answered_other_job_id: {
    type: "number" as const,
    description:
      "이번 답변이 [현재 공고]가 아니라 **다른 공고**에 관한 것이면 그 공고 번호(#뒤 숫자). 현재 공고 이야기면 생략.",
  },
  answered_other_job_fields: {
    type: "array" as const,
    items: { type: "string" as const, enum: [...CROSS_JOB_FIELD_NAMES] },
    description:
      "answered_other_job_id를 채웠으면, 그 공고에서 **인용한 항목명 전부**. 목록에 없는 값을 말했다면 비워 둬라.",
  },
};

/**
 * 결정적 백스톱 — 모델 자기신고를 검증한다. 모델이 규칙을 지킨다고 믿지 않는다.
 *
 * · 신고한 공고가 목록에 **없다** → 우리가 주지 않은 정보로 답한 것이다 → pause.
 * · 그 공고에 답할 값이 **하나도 없다** → 인용할 것이 없으니 지어낸 것이다 → pause.
 * · 다른 공고 이야기였는데 **advance** 를 골랐다 → 현재 공고 체크리스트 근거가 아니다 → stay로 내린다.
 *
 * 반환값이 null이면 강등할 것이 없다는 뜻.
 */
export function crossJobBackstop(
  result: Pick<StageResult, "answered_other_job_id" | "answered_other_job_fields" | "transition">,
  jobs?: OtherActiveJob[]
): { transition: StageTransition; why: string } | null {
  const answered = result.answered_other_job_id;
  if (answered == null) return null;

  const hit = (jobs ?? []).find((j) => j.job_id === answered);
  if (!hit) {
    return {
      transition: {
        kind: "pause",
        reason: `AI가 목록에 없는 공고(#${answered}) 기준으로 답했다고 신고 — 근거 없는 답변일 수 있어 발송 보류`,
        category: "cross_job",
        suggestedAction: "지원자가 물은 자리를 확인하고 그 공고 정보로 직접 답해 주세요.",
      },
      why: "unknown_job",
    };
  }
  if (hasNoAnswerableFacts(hit)) {
    return {
      transition: {
        kind: "pause",
        reason: `AI가 다른 공고(#${answered} ${hit.title})로 답했지만 그 공고엔 안내할 값이 하나도 없다 — 지어낸 답일 수 있어 발송 보류`,
        category: "cross_job",
        suggestedAction: "그 공고에 근무시간·급여·집결지를 채우면 다음부터 AI가 직접 답합니다.",
      },
      why: "no_facts",
    };
  }
  // **항목 단위 검증** — 모델이 인용했다고 신고한 항목이 그 공고에서 '미기재'면 지어낸 값이다.
  // id만 검증하면 "그 자리 급여는 얼마예요?"에 없는 급여를 답해도 통과한다.
  const missing = new Set(splitJobFacts(hit).missing);
  const invented = (result.answered_other_job_fields ?? []).filter((f) => missing.has(f));
  if (invented.length > 0) {
    return {
      transition: {
        kind: "pause",
        reason: `AI가 다른 공고(#${answered} ${hit.title})의 미기재 항목(${invented.join(", ")})을 답했다고 신고 — 지어낸 값일 수 있어 발송 보류`,
        category: "cross_job",
        suggestedAction: `그 공고에 ${invented.join(", ")}을 채우면 다음부터 AI가 직접 답합니다.`,
      },
      why: "invented_field",
    };
  }

  if (result.transition.kind === "advance") {
    // stay로 내리면 그 턴은 **완전 침묵**이 된다 — stage가 advance 턴의 reply_text를 이미 null로
    // 만들어서 문자도, 초안도, 인계 큐도 남지 않는다. pause로 내려 흔적을 남긴다.
    return {
      transition: {
        kind: "pause",
        reason: `AI가 다른 공고(#${answered} ${hit.title}) 이야기를 한 턴에 현재 공고 다음 단계 진행을 제안 — 안내 발송 보류`,
        category: "cross_job",
        suggestedAction: "지원자가 물은 자리에 답하고, 현재 공고 진행은 매니저가 확인 후 재개하세요.",
      },
      why: "advance_on_other_job",
    };
  }
  return null;
}
