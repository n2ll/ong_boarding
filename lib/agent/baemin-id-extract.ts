/**
 * 지원자의 inbound 메시지 묶음에서 배민 커넥트 아이디를 추출 (Claude Haiku).
 *
 * 사용처:
 *  - /api/admin/backfill-baemin-id: 과거 데이터 일괄 백필
 *
 * onboarding stage의 실시간 추출과 분리한 이유:
 *   - 실시간은 한 턴 단위(직전 인입 1개 + 컨텍스트)
 *   - 여기는 한 사람의 모든 inbound 묶음을 한 번에 보고 가장 확실한 ID 1개 추출
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

export interface ExtractedBaeminId {
  baemin_id: string | null;
  confidence: number;     // 0~1
  reasoning: string;
}

const SYSTEM_PROMPT = `너는 옹고잉(내이루리) 비마트 배송원 채용 매니저의 보조다.
한 지원자가 그동안 회사에 보낸 모든 SMS를 본 후, 거기에 '배민 커넥트 아이디'가 있으면 추출한다.

## 배민 커넥트 아이디 특징
- 영문(소문자 위주) + 숫자가 섞인 짧은 문자열 (대개 4~20자)
- 점·밑줄·하이픈 가능
- 예: miyoung0804 / eugene0909 / tpwlsdms1 / kim_delivery / hong-2024

## 출력 규칙
- 명확한 ID 1개를 발견하면 그 문자열 그대로 baemin_id에 담고 confidence ≥ 0.85
- 영문+숫자 토큰이 여러 개면 가장 ID 같은 것 1개만 (예: 폰번호·날짜 등 제외)
- 없으면 baemin_id=null, confidence ≥ 0.85 (없다고 확신)
- 애매하면 confidence 낮게 (0.4~0.6) — 호출자가 임계값으로 거를 수 있게
- 한국어만 있거나, 핸드폰번호(010xxxxxxxx) / 날짜 / URL은 ID 아님

extract_baemin_id tool로만 응답.`;

const TOOL = {
  name: "extract_baemin_id",
  description: "지원자가 보낸 메시지 묶음에서 배민 커넥트 아이디를 1개 추출한다.",
  input_schema: {
    type: "object" as const,
    properties: {
      baemin_id: {
        type: ["string", "null"] as const,
        description: "추출한 아이디 원본 문자열. 없으면 null.",
      },
      confidence: {
        type: "number",
        description: "0~1 확신도.",
      },
      reasoning: {
        type: "string",
        description: "어떤 메시지·토큰에서 어떻게 판단했는지 한 줄.",
      },
    },
    required: ["baemin_id", "confidence", "reasoning"],
  },
};

export interface ExtractBaeminIdInput {
  /** 시간순으로 정렬된 지원자 inbound 메시지 본문들 */
  inboundMessages: string[];
  /** 화면 표시용 — Claude에 컨텍스트로 함께 넣음 */
  applicantName?: string | null;
}

export async function extractBaeminIdFromHistory(
  opts: ExtractBaeminIdInput
): Promise<ExtractedBaeminId & { usage?: { model: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | null }> {
  const apiKey = process.env.CLAUDE_API;
  if (!apiKey) {
    return { baemin_id: null, confidence: 0, reasoning: "CLAUDE_API env missing" };
  }
  if (opts.inboundMessages.length === 0) {
    return { baemin_id: null, confidence: 1, reasoning: "no inbound messages" };
  }

  const userContent = [
    opts.applicantName ? `지원자 이름: ${opts.applicantName}` : null,
    `지원자가 보낸 메시지(${opts.inboundMessages.length}개, 시간순):`,
    "",
    ...opts.inboundMessages.map((m, i) => `[${i + 1}] ${m}`),
  ].filter(Boolean).join("\n");

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
        tool_choice: { type: "tool", name: "extract_baemin_id" },
        messages: [{ role: "user", content: userContent }],
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[baemin-id-extract] HTTP", res.status, err);
      return { baemin_id: null, confidence: 0, reasoning: `Haiku HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      content: Array<{ type: string; input?: { baemin_id?: string | null; confidence?: number; reasoning?: string } }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    };
    const block = data.content?.find((c) => c.type === "tool_use");
    const usage = { model: MODEL, ...(data.usage ?? {}) };
    if (!block?.input) {
      return { baemin_id: null, confidence: 0, reasoning: "no tool_use block", usage };
    }
    const out = block.input;
    return {
      baemin_id: typeof out.baemin_id === "string" && out.baemin_id.trim() ? out.baemin_id.trim() : null,
      confidence: typeof out.confidence === "number" ? out.confidence : 0,
      reasoning: out.reasoning || "",
      usage,
    };
  } catch (e) {
    console.error("[baemin-id-extract] exception", e);
    return {
      baemin_id: null,
      confidence: 0,
      reasoning: e instanceof Error ? e.message : "unknown",
    };
  }
}
