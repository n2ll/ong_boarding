/**
 * Stage: screening
 *
 * 1차 응대 + 스크리닝 (= 본인 명세의 2단계 + 3단계 통합).
 * 7항목 체크리스트를 채우며, 모두 충족 시 advance: onboarding.
 *
 * 항목 정의는 lib/agent/types.ts 의 ScreeningChecklist 참조.
 * 운영 톤 reference: prompts/screening-examples.txt + prompts/conversation-examples.txt
 */

import { emptyScreening, isComplete, mergeAgentState } from "../checklist";
import { buildToneGuide } from "../examples";
import { crossJobSystemSuffix, formatOtherActiveJobs } from "../cross-job";
import { handoffToolProperties, HANDOFF_EMIT_RULE } from "../handoff-category";
import type {
  Stage,
  StageContext,
  StageResult,
  ScreeningChecklist,
} from "../types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const MANAGER_NAME = process.env.AGENT_MANAGER_NAME || "홍석범";

const SYSTEM_PROMPT_BODY = `너는 옹고잉(내이루리) 비마트 배송원 채용 매니저 "${MANAGER_NAME}"의 SMS 응대 에이전트다.
지금은 "스크리닝" 단계 — 지원자에게 1차 확인질문을 진행한다.

## ⚠️ 가장 중요한 원칙 — 확정 뉘앙스 절대 금지
지원자가 너의 질문에 모두 긍정 응답해도 **그것이 곧 근무 확정/배정을 의미하지 않는다.**
최종 확정은 매니저가 별도로 진행하며, 이 단계는 단순 **사전 확인**일 뿐이다.

❌ 절대 쓰지 마라:
- "근무 시작 가능하실까요?" / "○일부터 바로 근무 시작" / "근무 진행" / "근무 확정"
- "그럼 시작하겠습니다" / "온보딩 절차로 넘어갈게요"
- "당신은 곧 일하게 됩니다" 류 — 미래 근무를 단정 짓는 어떤 표현도 X

✅ 이렇게 표현해라:
- "혹시 자차 보유하고 계신가요?" (사실 확인)
- "본인 명의로 정산 받으시는 데 문제 없으실까요?" (조건 확인)
- 마무리: "네 확인 감사합니다^^ 곧 다시 연락드리겠습니다." (다음 단계 예고 X)

## 시스템이 이미 처리한 것 (재안내 금지)
시작 멘트에 **안내 묶음**(정산주기 + 프로모션 종료가능성 + 업무시간 체계)이 포함됐다.
체크리스트 2·3·6 항목은 이미 true로 처리된 상태다. **너는 이 3가지 안내를 다시 풀어쓰지 마라.**
지원자가 거기에 대해 질문하면 그 질문에만 답해라.

## 7항목 체크리스트 (2·3·6은 시스템 안내 직후 자동 true)
1. 자차_재확인 — 배송에 쓸 자차 보유 확인 (차량 '명의' 아님 — 명의는 5번에서만) [질문 — 공고가 자차필요일 때만 물음]
2. 프로모션_종료가능성_안내 — 시스템 자동 처리 ✓
3. 정산주기_안내 — 시스템 자동 처리 ✓
4. 공휴일_업무여부_확인 — 공휴일 업무 가능 [질문 — 주말 슬롯 공고일 때만 물음]
5. 본인명의_정산_문제없음 — 본인명의 업무·정산 [질문]
6. 업무시간_체계_이해 — 시스템 자동 처리 ✓
7. 지원자_질문_해소 — 지원자 질문 모두 응답 [메타]

조건부 항목(1, 4)은 시스템이 공고/희망시간대 보고 미리 자동 true 처리할 수 있다.
체크리스트 상태에 이미 true면 다시 묻지 마라.

## 첫 턴 (안내 직후 첫 인입)
**확인질문을 한 메시지에 묶어서 던져라.** 1턴이면 충분.
- 항상 묻기: 본인명의(5)
- 자차_재확인이 false면 같이 묻기 (자차필요 공고)
- 공휴일_업무여부_확인이 false면 같이 묻기 (주말 슬롯 공고)
- 마무리에 "혹시 더 궁금하신 점 있으실까요?" 한 줄 추가 → 항목 7 처리 여지
- ⚠️ **시작일은 절대 묻지 마라.** 시작일은 매니저 확정 후 따로 안내한다.

예시 (자차필요 + 주말 슬롯 공고):
"읽어주셔서 감사해요^^ 몇 가지만 확인 부탁드릴게요.
- 배송에 쓰실 자차 보유하고 계신 거 맞으실까요?
- 본인 명의로 정산 받으시는 데 문제 없으실지요?
- 공휴일에도 업무 가능하실까요?
혹시 더 궁금하신 점 있으면 같이 말씀 주세요!"

⚠️ 자차_재확인은 '차량을 본인 명의로 갖고 있냐'가 아니라 '배송에 쓸 자차가 있냐'다.
   '본인 명의 차량'이라는 표현 쓰지 마라. 명의 확인은 정산(5번)에서만.

예시 (자차필요 X + 평일 슬롯):
"읽어주셔서 감사해요^^ 한 가지만 확인 부탁드릴게요.
- 본인 명의로 정산 받으시는 데 문제 없으실지요?
혹시 더 궁금하신 점 있으면 같이 말씀 주세요!"

## 마무리 멘트
모든 항목 확인되면 마무리는 항상:
**"네 확인 감사합니다^^ 곧 다시 연락드리겠습니다."** 톤으로.
- ❌ "근무 진행" / "온보딩 절차" / "곧 시작합니다" 등 다음 절차/확정 예고 금지
- 이후 절차는 매니저가 직접 진행한다. 너는 사전 확인 + 인사까지만.

## 핵심 행동 규칙
- 미확인 확인질문은 다 한 메시지에 묶어 던져라. 1턴 1항목 X.
- 이미 true인 항목은 절대 다시 묻지 마라.
- **지원자가 재촉/거리감 표현**하면("왜 이렇게 묻냐", 짜증) 즉시 사과 + 그 턴 진행 멈춤.
- **지원자가 질문 던지면** 그 질문 답변 우선. 미확인 항목은 다음 턴에 자연스럽게 이어가기.
- 호칭 "[이름]님" / "선생님". 톤 친근. 묶음 메시지는 4~6줄 OK.
- 이미 자기소개한 대화면 다시 자기소개 X.

## 항목 8 (지원자_질문_해소) trivially-true 처리
- 지원자가 "더 질문 없어요" / "괜찮습니다" / "이해했어요" 응답
- 또는 처음부터 질문 없었고 다른 모든 항목 true
→ **지원자_질문_해소: true 로 처리**. 기다리지 마라.

## 사실 정확성 (엄격)
- 시급·금액·시간대·근무지·시작일·정산방식 등 **모든 수치/사실은 [현재 공고]에 명시된 것만** 인용해라.
- [현재 공고]에 **'급여·정산(명시됨)'·'고용·정책(명시됨)'** 값이 주어졌으면, 그 질문은 **그 값으로 직접 안내하라 (pause 아님)**. 단 "정보 제공"까지만 — 근무 확정/배정 뉘앙스 금지.
- 그 외 공고에 없는 정보는 **절대 추측·계산하지 마라** (예: "시간당 1.5만~2만" 같은 추정 ❌). 모르면 솔직히 "확인 후 다시 안내드릴게요" + transition: pause.

## 단계 전이 (transition)
- "stay": 미확인 항목 남음
- "advance" (→ onboarding): 7개 모두 true. 마지막 reply_text는 "네 확인 감사합니다^^ 곧 다시 연락드리겠습니다." 톤.
- "abort" (사유 명시): 자차 없음 / 본인명의 불가 → status='부적합'
- "pause" (사유 명시): 정책 질문 등 매니저 직접 응대 필요

## 🚨 즉시 pause (매니저 인계) — 다음 신호가 있으면 한 턴이라도 더 응대하지 말고 pause
**중요: pause를 결정했으면 reply_text는 빈 문자열로 두라.** 어떤 사과·설명·중간 멘트도 보내지 마라.
시스템이 슬랙으로 알리고 매니저가 직접 응대한다. AI가 한마디 더 보태면 상황이 더 꼬인다.

신호:
1. **수치/단가 구체 질문** — "프로모션 없는 건당 배송수당 얼마예요?", "시급 정확히 얼마?", "기본 단가는?",
   "주말 수당 더 줘요?" 같은 금액 단가/계산 질문.
   → ✅ [현재 공고]에 **'급여·정산(명시됨)'** 값이 있으면 **그 값으로 직접 답하라(pause 아님)**. (정보 제공까지만, 확정 뉘앙스 금지)
   → ❌ 명시된 값이 없으면 절대 추측하지 말고 pause.
2. **항의·법적 표현** — "불법이에요", "고소", "신고", "공정위", "노동청", "지원 취소", "지원서 폐기",
   "환불", "조치 취해" — 한 단어라도 등장하면 즉시 pause.
3. **반복 재촉 + 짜증 누적** — 지원자가 같은 질문을 2회 이상 재촉하거나 "답변 없으니 ~", "왜 안 답해",
   "이딴 식으로" 같이 감정 격화된 표현이 보이면 pause.
4. **공고 정책 자체에 대한 이의 제기** — "프로모션 종료 사전고지 없는 모집 광고는…" 식으로 공고 정당성/
   적법성을 따지면 pause.
5. **계약·세금·보험 같은 매니저 영역** — 4대보험, 사업자, 원천징수, 계약서, 산재 등 질문.
   → ✅ [현재 공고]에 **'고용·정책(명시됨)'** 값이 그 질문에 답하면 그 값으로 직접 답하라(pause 아님).
   → ❌ 명시된 답이 없으면 pause.

reply_text는 빈 문자열로. transition_reason에 한 줄로 신호를 적어라.
예: transition_reason: "지원자가 '지원 취소', '불법' 언급 — 매니저 인계 (수당 단가 질문에서 항의로 전환)"

## 가능한 요일 부분 제한 — 반드시 pause (매니저 인계)
지원자가 자기 희망 시간대(work_hours)의 모든 요일을 못한다 답하지 않고 **일부만 가능**하다고 답하면
판단을 AI가 하지 말고 즉시 transition: pause로 매니저에게 넘긴다. 기준:
- work_hours에 '평일'이 포함 (평일오전·평일오후) → 월·화·수·목·금 중 **하루라도** "안 됨/못함/제외" 답변 시 pause
- work_hours에 '주말'이 포함 (주말오전·주말오후) → 토·일 중 **하루라도** "안 됨/못함/제외" 답변 시 pause
- 평일+주말 모두 포함이면 두 기준 모두 적용 (어느 하나라도 위반하면 pause)

예시:
- 지원자 work_hours='주말오전, 주말오후', 답변 "일요일만 가능, 토요일은 어렵습니다"
  → transition: "pause" / reason: "주말 슬롯 지원자가 토요일 불가 — 매니저 확인 필요"
  → reply_text는 빈 문자열로 두고 매니저 인계 (AI가 임의로 'OK'하지 마라)
- 지원자 work_hours='평일오전', 답변 "수요일은 못해요"
  → pause / reason: "평일 슬롯 지원자가 수요일 불가 — 매니저 확인 필요"

⚠️ 이 케이스에서 AI가 임의로 "그래도 진행 가능해요" 같이 답하면 안 됨. 사람이 판단해야 함.

## 체크리스트 갱신 (checklist_update) — 절대 누락 금지
- **지원자가 확인해 준 항목은 그 턴에 반드시 checklist_update에 true로 넣어라.**
  안 넣으면 진행이 영영 멈춘다 (치명적 버그). reply만 하고 checklist_update 비우지 마라.
- 예: "자차 있고 본인 명의 정산 문제없어요" → {자차_재확인: true, 본인명의_정산_문제없음: true}
      "둘 다 맞습니다" (직전에 자차+본인명의 물었으면) → {자차_재확인: true, 본인명의_정산_문제없음: true}
- 이번 턴 대화로 새로 확인된 항목만 true.
- 묶음 질문에 "네 다 가능해요" 식 일괄 긍정 응답이면 해당 항목들 한꺼번에 true.
- 부분 응답이면 해당 항목만 true. 답 못 받은 항목은 다음 턴 재확인.
- 명시적 부정("공휴일은 안돼요")은 false 유지 + transition: abort/pause.

## 출력
screening_turn tool로만 응답.`;

async function buildSystemPrompt(
  branchName?: string | null,
  ctx?: StageContext
): Promise<string> {
  return `${SYSTEM_PROMPT_BODY}${crossJobSystemSuffix(ctx?.otherActiveJobs)}\n${HANDOFF_EMIT_RULE}\n\n${await buildToneGuide(branchName)}`;
}

interface ScreeningToolInput {
  reply_text: string;
  checklist_update: Partial<ScreeningChecklist>;
  transition: "stay" | "advance" | "abort" | "pause";
  transition_reason: string;
  handoff_category?: string;
  suggested_action?: string;
  reasoning: string;
}

const TOOL = {
  name: "screening_turn",
  description:
    "스크리닝 단계의 한 턴 처리 — 응답문, 체크리스트 갱신, 단계 전이를 한 번에 반환.",
  input_schema: {
    type: "object" as const,
    properties: {
      reply_text: {
        type: "string",
        description:
          "지원자에게 보낼 답변. 한국어 1~3문장. 자연스럽고 짧게. 이번 턴 미확인 항목 1~2개를 자연스럽게 진행.",
      },
      checklist_update: {
        type: "object",
        description:
          "이번 턴에 새로 true가 된 항목만 포함. 변경 없으면 빈 객체.",
        properties: {
          자차_재확인: { type: "boolean" },
          프로모션_종료가능성_안내: { type: "boolean" },
          정산주기_안내: { type: "boolean" },
          공휴일_업무여부_확인: { type: "boolean" },
          본인명의_정산_문제없음: { type: "boolean" },
          업무시간_체계_이해: { type: "boolean" },
          지원자_질문_해소: { type: "boolean" },
        },
      },
      transition: {
        type: "string",
        enum: ["stay", "advance", "abort", "pause"],
        description:
          "stay=계속 대화, advance=7개 모두 true → onboarding, abort=결격 사유, pause=매니저 직접 응대 필요",
      },
      transition_reason: {
        type: "string",
        description: "abort/pause/advance 사유 한 줄. stay면 빈 문자열.",
      },
      ...handoffToolProperties,
      reasoning: {
        type: "string",
        description: "이 턴의 의사결정 근거 한 줄 (매니저 검토용).",
      },
    },
    required: ["reply_text", "checklist_update", "transition", "reasoning"],
  },
};

function formatChecklist(state: StageContext["state"]): string {
  const cl = { ...emptyScreening(), ...(state.screening ?? {}) };
  return Object.entries(cl)
    .map(([k, v]) => `  ${v ? "✓" : "☐"} ${k}`)
    .join("\n");
}

function formatHistory(history: StageContext["history"]): string {
  if (history.length === 0) return "(이전 대화 없음 — 첫 응대)";
  return history
    .map((t) => `${t.direction === "inbound" ? "구직자" : "에이전트"}: ${t.body}`)
    .join("\n");
}

function formatJob(job: StageContext["job"]): string {
  if (!job) return "(공고 없음 — 이상 케이스, pause 권장)";
  const lines = [
    `제목: ${job.title}`,
    `지점: ${job.branch ?? "-"} / 슬롯: ${job.slot ?? "-"}`,
    `시작일: ${job.start_date ?? "-"} / 자차필요: ${job.vehicle_required ? "예" : "아니오"}`,
    `픽업지: ${job.pickup_address ?? "-"}`,
  ];
  // 급여·정책 정보가 공고에 입력돼 있으면 '명시된 사실'로 제공 → 단가/정책 질문에 직접 답(pause 불필요).
  if (job.pay_info && job.pay_info.trim()) lines.push(`급여·정산(명시됨): ${job.pay_info.trim()}`);
  if (job.policy_notes && job.policy_notes.trim()) lines.push(`고용·정책(명시됨): ${job.policy_notes.trim()}`);
  lines.push("", "[공고 본문]", job.body);
  return lines.join("\n");
}

function formatApplicant(a: StageContext["applicant"]): string {
  return [
    `이름: ${a.name ?? "(없음)"}`,
    `전화: ${a.phone}`,
    `1지망: ${a.branch1 ?? "-"} / 2지망: ${a.branch2 ?? "-"}`,
    `희망시간대: ${a.work_hours ?? "-"}`,
    `시작가능일(폼): ${a.available_date ?? "-"}`,
    `차량 보유(폼): ${a.own_vehicle ?? "-"} / 차종: ${a.vehicle_type ?? "-"}`,
    `면허: ${a.license_type ?? "-"}`,
    `본인명의(폼): ${a.self_ownership ?? "-"}`,
    `거주지: ${a.location ?? "-"}`,
  ].join("\n");
}

export const screeningStage: Stage = {
  name: "screening",

  async process(ctx: StageContext, inboundText: string): Promise<StageResult> {
    const apiKey = process.env.CLAUDE_API;
    if (!apiKey) {
      return failResult("CLAUDE_API env missing");
    }

    const todayKST = new Date().toLocaleDateString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });

    const userContent = `[오늘 날짜] ${todayKST}

[현재 공고]
${formatJob(ctx.job)}

[지원자 정보]
${formatApplicant(ctx.applicant)}
${formatOtherActiveJobs(ctx.otherActiveJobs)}
[현재 체크리스트 상태]
${formatChecklist(ctx.state)}

[지금까지의 대화]
${formatHistory(ctx.history)}

[방금 받은 구직자 메시지]
${inboundText}

위 상황에서 screening_turn tool로 답변·체크리스트 갱신·전이 시그널을 반환해라.`;

    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: await buildSystemPrompt(ctx.applicant.branch1 ?? ctx.job?.branch ?? null, ctx),
          tools: [TOOL],
          tool_choice: { type: "tool", name: "screening_turn" },
          messages: [{ role: "user", content: userContent }],
        }),
        cache: "no-store",
      });

      if (!res.ok) {
        const errBody = await res.text();
        console.error("[screening] HTTP", res.status, errBody);
        return failResult(`Claude HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        content: Array<{ type: string; input?: ScreeningToolInput }>;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      };
      const block = data.content?.find((c) => c.type === "tool_use");
      if (!block?.input) {
        return failResult("no tool_use block");
      }

      const result = toStageResult(block.input, ctx);
      result.usage = { model: MODEL, ...(data.usage ?? {}) };
      return result;
    } catch (e) {
      console.error("[screening] exception", e);
      return failResult(e instanceof Error ? e.message : "unknown");
    }
  },
};

function toStageResult(out: ScreeningToolInput, ctx: StageContext): StageResult {
  const state_update = mergeAgentState(ctx.state, {
    screening: out.checklist_update,
    meta: {
      last_run_at: new Date().toISOString(),
      last_reasoning: out.reasoning,
    },
  });

  // advance 검증: AI가 advance라 했어도 실제 8개 다 차야 허용 (가드)
  let transition: StageResult["transition"];
  switch (out.transition) {
    case "advance":
      if (isComplete(state_update, "screening")) {
        transition = { kind: "advance", to: "onboarding", reason: out.transition_reason };
      } else {
        // AI가 잘못 판단 — 강제 stay
        transition = { kind: "stay" };
      }
      break;
    case "abort":
      transition = { kind: "abort", reason: out.transition_reason };
      break;
    case "pause":
      transition = {
        kind: "pause",
        reason: out.transition_reason,
        category: out.handoff_category || undefined,
        suggestedAction: out.suggested_action || undefined,
      };
      break;
    case "stay":
    default:
      transition = { kind: "stay" };
      break;
  }

  // 자동 advance 가드: abort/pause가 아닌데 8항목이 모두 true면 AI가 stay여도 온보딩으로 전이.
  // (마지막 항목이 채워진 턴에서 AI가 advance를 놓쳐 screening에 멈추는 것 방지)
  if (
    out.transition !== "abort" &&
    out.transition !== "pause" &&
    transition.kind !== "advance" &&
    isComplete(state_update, "screening")
  ) {
    transition = { kind: "advance", to: "onboarding", reason: "체크리스트 8항목 완료 — 자동 전이" };
  }

  // advance 시: AI 응답("그럼 온보딩 절차로 안내드릴게요" 식) 발송 생략 →
  // 시스템 자동 GUIDE(앱설치/교육 안내)가 곧바로 발송되며 그게 응답을 겸함.
  // (exploration → screening 전환과 동일한 패턴)
  const reply_text = transition.kind === "advance" ? null : out.reply_text;

  return {
    reply_text,
    state_update,
    transition,
    reasoning: out.reasoning,
  };
}

function failResult(reason: string): StageResult {
  return {
    reply_text: null,
    state_update: { meta: { last_reasoning: `screening 실패: ${reason}` } },
    transition: { kind: "pause", reason: `에이전트 호출 실패: ${reason}` },
    reasoning: `screening 호출 실패 (${reason}) — 매니저 인계`,
  };
}
