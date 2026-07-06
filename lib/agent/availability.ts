/**
 * 인바운드 SMS 가용성 신호 분류기 (Claude Haiku 4.5).
 *
 * 재컨택(ping) 응답·풀 지원자의 문자에서 "언제 일할 수 있는지"만 추출해
 * applicants.availability(즉시가능/이번주가능/휴면) 갱신 재료로 쓴다.
 *
 * 호출부: /api/webhooks/supabase-new-message — 매칭된 지원자 중
 *   (a) 활성 job_candidate가 없거나(풀 응답), (b) 최근 14일 내 ping_sent가 있을 때만.
 *   일반 스크리닝 대화 전부에 붙이지 않는 것은 비용 가드(§5.7)와
 *   "좋은 기사를 가용성 확인으로 괴롭히지 않기" 원칙 때문 — 가용성은 질문이 아니라
 *   이미 도착한 행동(답장)에서만 추론한다.
 *
 * 강등 금지 규칙(pull interest 라우트와 동일): '즉시가능'은 this_week 신호로
 * 내려가지 않는다. 명시적 거절/중단 요청(unavailable)만 '휴면'으로 강등.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

export type AvailabilitySignal = "immediate" | "this_week" | "unavailable" | "opt_out" | "none";

export interface AvailabilitySignalResult {
  signal: AvailabilitySignal;
  confidence: number;
  reasoning: string;
  usage?: {
    model: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
}

interface AvailabilityToolInput {
  signal: AvailabilitySignal;
  confidence: number;
  reasoning: string;
}

const SYSTEM_PROMPT = `너는 옹고잉(내이루리) 배송원 인력풀 관리자의 SMS 응답 분류기다.
인력풀 지원자가 보낸 문자에서 "언제부터 일할 수 있는지"에 대한 신호만 분류해라.
채용 확정·배정 판단이 아니다 — 순수하게 가용 의사 신호만 본다.

## signal 분류 기준
- "immediate": 오늘/내일/당장/바로/지금 일할 수 있다는 표현. 예: "당장 가능합니다", "내일부터 나갈 수 있어요"
- "this_week": 일할 의사·관심이 있다는 긍정 표현(시점이 구체적이지 않아도). 예: "가능합니다", "관심 있어요", "주말은 돼요", "오전이면 가능해요", "연락 부탁드립니다"
- "unavailable": 지금은 일할 수 없다는 거절 — 단, 연락 자체를 거부한 건 아님. 예: "다른 일 구했어요", "당분간 어렵습니다", "관심 없어요"
- "opt_out": **연락 중단 요청** — 문자/안내 자체를 그만 보내달라는 명시적 표현. 예: "그만", "그만 연락주세요", "문자 그만 보내주세요", "수신거부", "차단할게요"
- "none": 가용성과 무관한 내용(단순 질문, 단가 문의, 인사, 서류·앱 관련 대화 등). **애매하면 none.**

unavailable과 opt_out의 구분이 중요하다: "일 못한다"는 unavailable, "연락하지 마라"는 opt_out. 둘 다 해당하면 opt_out.

## 출력 규칙
- 확실한 신호 → confidence ≥ 0.8
- 있는 것 같지만 표현이 약함 → confidence 0.5~0.7
- 판단 근거는 reasoning에 한 줄

availability_signal tool로만 응답.`;

const TOOL = {
  name: "availability_signal",
  description: "문자에서 가용성 신호(immediate/this_week/unavailable/none)를 분류한다.",
  input_schema: {
    type: "object" as const,
    properties: {
      signal: {
        type: "string",
        enum: ["immediate", "this_week", "unavailable", "opt_out", "none"],
        description: "가용성 신호 분류 결과.",
      },
      confidence: { type: "number", description: "0~1 확신도." },
      reasoning: { type: "string", description: "판단 근거 한 줄." },
    },
    required: ["signal", "confidence", "reasoning"],
  },
};

export async function classifyAvailabilitySignal(opts: {
  body: string;
}): Promise<AvailabilitySignalResult> {
  const apiKey = process.env.CLAUDE_API;
  if (!apiKey) {
    return { signal: "none", confidence: 0, reasoning: "CLAUDE_API env missing" };
  }

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
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "availability_signal" },
        messages: [{ role: "user", content: `메시지:\n${opts.body}` }],
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error("[availability] HTTP", res.status, errBody);
      return { signal: "none", confidence: 0, reasoning: `Haiku HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      content: Array<{ type: string; input?: AvailabilityToolInput }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    };
    const block = data.content?.find((c) => c.type === "tool_use");
    const usage = { model: MODEL, ...(data.usage ?? {}) };
    if (!block?.input) {
      return { signal: "none", confidence: 0, reasoning: "no tool_use block", usage };
    }
    const out = block.input;
    const valid: AvailabilitySignal[] = ["immediate", "this_week", "unavailable", "opt_out", "none"];
    return {
      signal: valid.includes(out.signal) ? out.signal : "none",
      confidence: typeof out.confidence === "number" ? out.confidence : 0,
      reasoning: out.reasoning || "",
      usage,
    };
  } catch (e) {
    console.error("[availability] exception", e);
    return {
      signal: "none",
      confidence: 0,
      reasoning: e instanceof Error ? e.message : "unknown",
    };
  }
}
