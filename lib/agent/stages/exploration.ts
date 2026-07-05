/**
 * Stage: exploration
 *
 * 진입 단계. 지원자가 공고/근무조건/프로세스에 대해 묻고 탐색할 수 있도록
 * 답변만 제공한다. 체크리스트 X. 지원의사가 명확해지면 → screening 으로 advance.
 *
 * 지원의사 시그널 예시:
 *   - 명시적: "지원할게요", "할게요", "해볼게요", "지원하겠습니다", "신청합니다"
 *   - 강한 암시: "언제부터 시작할 수 있나요?", "면접 어디서 보나요?", "다음 절차는?"
 *   - 약한 암시(stay): "괜찮아 보이네요", "고민해볼게요" — 본인이 결정 못 한 상태
 *
 * 거절 시그널:
 *   - "관심 없어요", "다른 일자리 구했어요", "안 할게요" → abort
 */

import { mergeAgentState } from "../checklist";
import { buildToneGuide } from "../examples";
import { crossJobSystemSuffix, formatOtherActiveJobs } from "../cross-job";
import { handoffToolProperties, HANDOFF_EMIT_RULE } from "../handoff-category";
import type {
  Stage,
  StageContext,
  StageResult,
} from "../types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MANAGER_NAME = process.env.AGENT_MANAGER_NAME || "홍석범";

const SYSTEM_PROMPT_BODY = `너는 옹고잉(내이루리) 비마트 배송원 채용 매니저 "${MANAGER_NAME}"의 SMS 응대 에이전트다.
지금은 "탐색(exploration)" 단계 — 지원자가 공고를 보고 문의했거나, 매니저가 후보로 발송한 후 첫 응대 중이다.
아직 지원의사가 확정되지 않은 상태로, 너의 역할은 **질문에 답하고 정보를 제공하는 것**이지 지원자를 끌고 가는 게 아니다.

## 너의 목표
1. 지원자가 [현재 공고]·근무조건·프로세스에 대해 궁금해하는 것에 자연스럽게 답한다.
2. 답변 마무리에는 가볍게 "더 궁금하신 점 있으면 편하게 말씀 주세요" 톤으로 열어둔다.
3. 지원자가 **명확히 지원의사를 보이면** transition: "advance" (다음 단계: screening)
4. 지원자가 **명확히 거절하면** transition: "abort"
5. 정책/예외/매니저 권한이 필요한 사안은 transition: "pause"

## 절대 하지 말 것
- 체크리스트 식 확인 질문 금지 ("자차 보유하셨나요?" "공휴일도 가능하세요?" 등). 그건 다음 단계 일이다.
- 지원자가 묻지도 않은 정보를 들이대지 마라. 매니저가 "안내해드릴 게 많은데..." 식으로 시작하지 않는 것처럼.
- 첫 응대인데 "몇 가지 확인해드릴게요" 같은 정형문 금지.

## 첫 응대 패턴
- **직전 대화(history)에 이미 outbound(시작 멘트·매니저·시스템)에서 인사나 소개가 나갔다면, 절대 다시 자기소개하지 마라.** "안녕하세요 OOO입니다 / 담당 매니저입니다" 반복 금지. 바로 가볍게 받아라.
  · 예: 지원자가 "안녕하세요 연락 주셨네요~" → "네 영록님 ㅎㅎ 편하게 문의 주세요!" 정도면 충분
- history가 정말 비어있을 때만 짧게 인사 + 한 줄 소개.
- 지원자가 단순히 "안녕하세요"만 보냈으면 거기서 끝내라. 묻지 않은 걸 안내하지 마라.

## 말투 — AI 티 내지 마라 (중요)
- **정형 마무리 문구 금지**: "궁금하신 점 있으시면 편하게 말씀 주세요", "언제든 문의 주세요" 같은 닫는 정형문을 매번 붙이지 마라. 매니저는 그렇게 안 한다.
- 한 메시지 **1~2문장**이 기본. 길게 늘어놓지 마라.
- 호칭은 "OOO님" 한 번이면 충분. 매 문장 이름 반복 금지.
- 톤 가이드의 매니저 실제 메시지 길이·말투를 그대로 따라라. 격식체보다 가벼운 구어체.

## 지원의사 판단 (advance 트리거)
**advance(→ screening) 해라:**
- 명시 표현: "지원할게요", "할게요", "해볼게요", "신청합니다", "진행 부탁드립니다"
- 절차 질문: "다음 절차가 어떻게 되나요?", "면접·교육은 어디서?", "언제부터 시작 가능한가요?"
- 제안 수락: "그럼 시작 언제부터 가능할까요?" 처럼 시작 방향으로 들어옴

**stay 유지:**
- 단순 정보 확인 ("시급이 얼마예요?", "주말도 있나요?")
- 미정 상태 ("고민해볼게요", "괜찮아 보이네요")
- 거절도 수락도 아닌 중립

**abort 해라:**
- 명시 거절: "관심 없어요", "다른 일자리 구했어요", "안 할게요"
- 톤 다운 후 한 번 더 확인하지 말고 깔끔히 마무리 인사로 끝내라.

## advance 시 reply_text
"네 좋습니다, ${MANAGER_NAME ? "" : ""}바로 안내드릴게요" 식으로 자연스럽게 다음 단계로 넘어가는 한 줄.
같은 메시지에 체크리스트 항목 묻지 마라 — 그건 screening 단계에서 시스템이 이어서 처리한다.

## 사실 정확성 (엄격)
- 시급·금액·시간대·근무지·시작일·픽업지·정산방식 등 **모든 수치/사실은 [현재 공고] 본문에 명시된 것만 인용**해라.
- 공고에 없는 정보는 **절대 추측·계산하지 마라.**
  · 예시: 공고에 "건당 5천원"만 있는데 "회차당 3~4건이니 시간당 15,000원" 같은 추측 ❌
  · 예시: 공고에 시간만 있는데 "월급 환산하면 200만원 정도" 같은 추정 ❌
- 모르는 정보는 솔직히 "제가 확인 후 다시 안내드릴게요" 후 transition: "pause" reason="정보 확인 필요".

## 다른 지점·공고 문의 — 회피 답변 금지 (반드시 pause)
지원자가 [현재 공고]·applicant.introduction에 명시되지 않은 **다른 지점**(예: 마포상암, 강남 등)이나
다른 시간대·다른 공고를 묻는 경우, 절대 다음과 같이 회피하지 마라:
- ❌ "제 담당 지점이 아니에요"
- ❌ "그쪽은 다른 매니저가 담당이에요"
- ❌ "제가 담당하는 X 지점만 안내 드릴 수 있어요"

대신 반드시:
- reply_text는 "확인 후 안내드릴게요" 정도의 짧은 한 줄
- transition: "pause" / reason="다른 지점·공고 문의 — 매니저 확인 필요"

이유: 다른 지점도 회사 전체 운영 항목이라 매니저가 현황 보고 직접 답변·연결해야 함.
AI가 임의로 차단/회피하면 신뢰도와 모집 기회 모두 손해.

## 출력
exploration_turn tool로만 응답.`;

async function buildSystemPrompt(
  branchName?: string | null,
  ctx?: StageContext
): Promise<string> {
  return `${SYSTEM_PROMPT_BODY}${crossJobSystemSuffix(ctx?.otherActiveJobs)}\n${HANDOFF_EMIT_RULE}\n\n${await buildToneGuide(branchName)}`;
}

interface ExplorationToolInput {
  reply_text: string;
  transition: "stay" | "advance" | "abort" | "pause";
  transition_reason: string;
  handoff_category?: string;
  suggested_action?: string;
  intent_signal: "exploring" | "ready_to_apply" | "rejected" | "manager_needed";
  reasoning: string;
}

const TOOL = {
  name: "exploration_turn",
  description:
    "탐색 단계 한 턴 처리 — 응답문 + 지원의사 판단 + 단계 전이 시그널.",
  input_schema: {
    type: "object" as const,
    properties: {
      reply_text: {
        type: "string",
        description:
          "지원자에게 보낼 답변. 한국어 1~3문장. 매니저 톤(친근, 짧음).",
      },
      transition: {
        type: "string",
        enum: ["stay", "advance", "abort", "pause"],
        description:
          "stay=정보제공/탐색 중, advance=지원의사 명확 → screening, abort=거절 확정, pause=매니저 직접 응대 필요",
      },
      transition_reason: {
        type: "string",
        description: "advance/abort/pause 사유 한 줄. stay면 빈 문자열.",
      },
      ...handoffToolProperties,
      intent_signal: {
        type: "string",
        enum: ["exploring", "ready_to_apply", "rejected", "manager_needed"],
        description: "이번 턴 지원자 의도 분류 (분석/감사용).",
      },
      reasoning: {
        type: "string",
        description: "이 턴의 의사결정 근거 한 줄 (매니저 검토용).",
      },
    },
    required: ["reply_text", "transition", "intent_signal", "reasoning"],
  },
};

function formatHistory(history: StageContext["history"]): string {
  if (history.length === 0) return "(이전 대화 없음 — 첫 응대)";
  return history
    .map((t) => `${t.direction === "inbound" ? "구직자" : "에이전트"}: ${t.body}`)
    .join("\n");
}

function formatJob(job: StageContext["job"]): string {
  if (!job) return "(공고 없음 — 일반 문의)";
  const lines = [
    `제목: ${job.title}`,
    `지점: ${job.branch ?? "-"} / 슬롯: ${job.slot ?? "-"}`,
    `시작일: ${job.start_date ?? "-"} / 자차필요: ${job.vehicle_required ? "예" : "아니오"}`,
    `픽업지: ${job.pickup_address ?? "-"}`,
  ];
  // 급여·정책 정보가 공고에 입력돼 있으면 '명시된 사실'로 제공 → 단가/정책 질문에 직접 답(pause 불필요).
  if (job.pay_type) {
    const amt = typeof job.pay_amount === "number" ? ` ${job.pay_amount.toLocaleString("ko-KR")}원` : "";
    lines.push(`대표 단가(명시됨): ${job.pay_type}${amt}`);
  }
  if (job.pay_info && job.pay_info.trim()) lines.push(`급여·정산(명시됨): ${job.pay_info.trim()}`);
  if (job.policy_notes && job.policy_notes.trim()) lines.push(`고용·정책(명시됨): ${job.policy_notes.trim()}`);
  if (job.ai_facts && job.ai_facts.trim()) lines.push(`공고 참고정보(명시됨): ${job.ai_facts.trim()}`);
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
    `차량 보유(폼): ${a.own_vehicle ?? "-"}`,
    `거주지: ${a.location ?? "-"}`,
  ].join("\n");
}

export const explorationStage: Stage = {
  name: "exploration",

  async process(ctx: StageContext, inboundText: string): Promise<StageResult> {
    const apiKey = process.env.CLAUDE_API;
    if (!apiKey) {
      return failResult("CLAUDE_API env missing");
    }

    const userContent = `[현재 공고]
${formatJob(ctx.job)}

[지원자 정보]
${formatApplicant(ctx.applicant)}
${formatOtherActiveJobs(ctx.otherActiveJobs)}
[지금까지의 대화]
${formatHistory(ctx.history)}

[방금 받은 구직자 메시지]
${inboundText}

위 상황에서 exploration_turn tool로 답변·전이 시그널을 반환해라.`;

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
          tool_choice: { type: "tool", name: "exploration_turn" },
          messages: [{ role: "user", content: userContent }],
        }),
        cache: "no-store",
      });

      if (!res.ok) {
        const errBody = await res.text();
        console.error("[exploration] HTTP", res.status, errBody);
        return failResult(`Claude HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        content: Array<{ type: string; input?: ExplorationToolInput }>;
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
      console.error("[exploration] exception", e);
      return failResult(e instanceof Error ? e.message : "unknown");
    }
  },
};

function toStageResult(out: ExplorationToolInput, ctx: StageContext): StageResult {
  const state_update = mergeAgentState(ctx.state, {
    meta: {
      last_run_at: new Date().toISOString(),
      last_reasoning: out.reasoning,
      last_intent_signal: out.intent_signal,
    },
  });

  let transition: StageResult["transition"];
  switch (out.transition) {
    case "advance":
      transition = { kind: "advance", to: "screening", reason: out.transition_reason };
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

  // advance 시: AI 응답("네 좋습니다 바로 안내드릴게요") 발송 생략 →
  // 시스템 자동 안내 묶음(buildScreeningAnnouncement)이 곧바로 발송되며 그게 응답을 겸함.
  const reply_text = out.transition === "advance" ? null : out.reply_text;

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
    state_update: { meta: { last_reasoning: `exploration 실패: ${reason}` } },
    transition: { kind: "pause", reason: `에이전트 호출 실패: ${reason}` },
    reasoning: `exploration 호출 실패 (${reason}) — 매니저 인계`,
  };
}
