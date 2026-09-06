import { buildToneGuide } from "../examples";
import { consultationSystemSuffix, formatConsultationContext, readConsultationResult, withConsultationTool } from "../multi-job-consultation";
import type { StageContext, StageResult } from "../types";

const MODEL = "claude-sonnet-4-6";
const TOOL = {
  name: "consultation_turn",
  description: "안내 가능한 공고의 확인된 조건, 관심·가능 시간 발언 또는 대상 확인을 반환한다.",
  input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
};

function failResult(ctx: StageContext, reason: string): StageResult {
  return {
    reply_text: null,
    state_update: { ...ctx.state },
    transition: { kind: "pause", reason: `공고 상담 확인 필요: ${reason}` },
    reasoning: `공고 상담 중단 — ${reason}`,
  };
}

/** active는 체크리스트 없이 상담만 수행하며 현재 공고 진행 모드도 허용하지 않는다. */
export async function processConsultation(ctx: StageContext, inboundText: string): Promise<StageResult> {
  if (!ctx.consultation) return failResult(ctx, "상담 컨텍스트 없음");
  const apiKey = process.env.CLAUDE_API;
  if (!apiKey) return failResult(ctx, "CLAUDE_API env missing");
  const consultationCtx: StageContext = { ...ctx, consultation: { ...ctx.consultation, force: true } };
  const history = ctx.history.map((turn) => `${turn.direction === "inbound" ? "구직자" : "에이전트"}: ${turn.body}`).join("\n");

  try {
    const tone = await buildToneGuide(null, { includeCommonFacts: false, includeConversationExamples: false });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: `너는 옹고잉 채용 상담 에이전트다. 확인된 공고 조건만 안내하고 관심·가능 시간은 원문으로 구분한다. 근무 확정·배정은 매니저가 결정한다. 상담으로 단계, 체크리스트, 지원자 프로필을 변경하지 않는다.\n${tone}${consultationSystemSuffix(consultationCtx)}`,
        tools: [withConsultationTool(TOOL, consultationCtx)],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: [{ role: "user", content: `${formatConsultationContext(consultationCtx)}\n[지금까지의 대화]\n${history || "(이전 대화 없음)"}\n\n[방금 받은 메시지]\n${inboundText}` }],
      }),
      cache: "no-store",
    });
    if (!response.ok) return failResult(ctx, `Claude HTTP ${response.status}`);
    const data = await response.json() as {
      content?: Array<{ type: string; input?: { consultation?: unknown } }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    };
    const input = data.content?.find((block) => block.type === "tool_use")?.input;
    const result = input
      ? readConsultationResult(input, consultationCtx, inboundText) ?? failResult(ctx, "상담 결과 없음")
      : failResult(ctx, "no tool_use block");
    result.usage = { model: MODEL, ...(data.usage ?? {}) };
    return result;
  } catch (error) {
    return failResult(ctx, error instanceof Error ? error.message : "unknown");
  }
}
