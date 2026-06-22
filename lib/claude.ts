/**
 * Claude API — 구인 공고 텍스트에서 구조화된 정보 추출 (Tool Use)
 *
 * 사용량 적재: 두 함수 모두 optional `supabase`를 받아 응답이 오면 ai_usage_daily에 UPSERT.
 * 공고 생성/추출은 messages 테이블에 안 들어가는 호출이라 daily 집계만 한다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordUsage } from "./agent/usage";

export interface ExtractedJobInfo {
  address: string;
  vehicle_required: boolean;
  schedule?: string;
  summary?: string;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

interface AnthropicResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; name: string; input: ExtractedJobInfo }
  >;
  stop_reason?: string;
}

export interface GeneratedPosting {
  posting: string;
  missing: string[];
}

const POSTING_SYSTEM_PROMPT = `너는 인력 공급 회사(내이루리)의 공고 작성 전문가다.
매니저가 짧고 거친 메모를 던지면, 배송원 후보들에게 SMS로 발송할 깔끔한 공고문으로 다듬어라.

## 공고문 작성 규칙
- 한국어, 친근하고 명확한 톤. 인사말·서론 없이 바로 본론.
- 유니코드 이모지로 섹션 구분: 📦 업무 / ✅ 우대·필수 / ⏰ 스케줄 / 📍 근무지 / 💰 급여 / 🙋 지원 방법
- Slack 콜론 이모지(:package: 같은 것) 절대 쓰지 마라. 무조건 유니코드.
- 제목 첫 줄: [지역/조건] 직무 모집 형태 (예: "[주말, 강북미아] 장보기 근거리 배송원 모집, 자차")
- SMS 발송용이므로 너무 길지 않게. 핵심 정보만 보기 좋게.
- 회사명/연락처/카톡 링크 멋대로 지어내지 마라. 메모에 없으면 "지원 방법"에는 "📩 본 문자에 답장으로 지원 부탁드립니다." 정도로만.

## 필수 항목 (메모에 있어야 할 것)
업무 / 근무지 / 스케줄 / 급여 / 차량 조건

메모에 빠진 항목은 missing 배열에 한국어 라벨로 담고, 공고문 해당 자리에는 [?] 로 표기해라.
예: 메모에 급여가 없으면 "💰 급여\n• [?]" 로 두고 missing: ["급여"].

## 출력
generate_posting tool로만 응답해라.`;

export async function generateJobPosting(
  rough: string,
  supabase?: SupabaseClient
): Promise<GeneratedPosting | null> {
  const apiKey = process.env.CLAUDE_API;
  if (!apiKey) {
    console.error("[claude] CLAUDE_API env missing");
    return null;
  }
  const MODEL = "claude-sonnet-4-6";

  const body = {
    model: MODEL,
    max_tokens: 2048,
    system: POSTING_SYSTEM_PROMPT,
    tools: [
      {
        name: "generate_posting",
        description: "거친 구인 메모를 SMS 발송용 공고문으로 다듬어 반환합니다.",
        input_schema: {
          type: "object",
          properties: {
            posting: {
              type: "string",
              description:
                "완성된 공고문 전문. 첫 줄은 제목, 이후 빈 줄과 섹션(📦/✅/⏰/📍/💰/🙋)으로 구성. 줄바꿈은 실제 개행 문자(\\n).",
            },
            missing: {
              type: "array",
              items: { type: "string" },
              description:
                "메모에 빠져 있어 [?]로 채운 항목들의 한국어 라벨 (예: ['급여', '근무 시작일']). 모두 채워졌으면 빈 배열.",
            },
          },
          required: ["posting", "missing"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "generate_posting" },
    messages: [{ role: "user", content: rough }],
  };

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[claude] HTTP", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as {
      content: Array<{ type: string; name?: string; input?: GeneratedPosting }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    };
    if (supabase) {
      await recordUsage(supabase, { model: MODEL, purpose: "job_generate", usage: data.usage });
    }
    const block = data.content?.find((c) => c.type === "tool_use");
    if (!block || !block.input) {
      console.error("[claude] no tool_use block", JSON.stringify(data));
      return null;
    }
    return block.input;
  } catch (err) {
    console.error("[claude] generateJobPosting exception", err);
    return null;
  }
}

export async function extractJobInfo(
  posting: string,
  supabase?: SupabaseClient
): Promise<ExtractedJobInfo | null> {
  const apiKey = process.env.CLAUDE_API;
  if (!apiKey) {
    console.error("[claude] CLAUDE_API env missing");
    return null;
  }
  const MODEL = "claude-sonnet-4-6";

  const body = {
    model: MODEL,
    max_tokens: 512,
    tools: [
      {
        name: "extract_job_info",
        description:
          "구인 공고 텍스트에서 배송원 매칭에 필요한 정보를 추출합니다.",
        input_schema: {
          type: "object",
          properties: {
            address: {
              type: "string",
              description:
                "상차지/근무지 주소. 시/도 + 시/군/구 + 동/면/리 단위까지 추출 (예: '서울 마포구 상암동'). 도로명·지번까지 명시되면 함께 포함.",
            },
            vehicle_required: {
              type: "boolean",
              description:
                "자기 명의 차량 필요 여부. 공고에 '차량 필요', '자차 필수' 등이 있으면 true. '차량 무관', '도보 가능' 등이면 false. 명시 안 됐으면 true(기본값).",
            },
            schedule: {
              type: "string",
              description:
                "근무 시간대 (예: '평일 오전', '월~금 08:00~13:00'). 명시 안 됐으면 빈 문자열.",
            },
            summary: {
              type: "string",
              description: "공고 한 줄 요약 (최대 60자).",
            },
          },
          required: ["address", "vehicle_required"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "extract_job_info" },
    messages: [{ role: "user", content: posting }],
  };

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[claude] HTTP", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as AnthropicResponse & {
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    };
    if (supabase) {
      await recordUsage(supabase, { model: MODEL, purpose: "job_extract", usage: data.usage });
    }
    const block = data.content?.find((c) => c.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      console.error("[claude] no tool_use block", JSON.stringify(data));
      return null;
    }
    return block.input;
  } catch (err) {
    console.error("[claude] exception", err);
    return null;
  }
}
