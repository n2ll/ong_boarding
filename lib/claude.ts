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

// ──────────────────────────────────────────────────────────────────────────
// 멀티 채널 공고 자동작성 — 당근알바 / 알바몬 / 문자(SMS) 형식
// ──────────────────────────────────────────────────────────────────────────

export interface MultiPlatformPosting {
  /** 공통 한 줄 제목 */
  title: string;
  /** 미리보기 카드용 구조화 필드 */
  fields: {
    company: string;
    location: string;
    pay: string;
    schedule: string;
    role: string;
    tags: string[];
  };
  /** 채널별 본문 */
  danggeun: { title: string; body: string };
  albamon: { title: string; body: string };
  sms: { title: string; body: string };
}

const MULTI_PLATFORM_SYSTEM_PROMPT = `너는 시니어(50~70대) 긱워커 채용에 특화된 인력 공급 회사 '옹보딩'의 채용 공고 카피라이터다.
매니저가 짧고 거친 채용 메모를 던지면, 동일한 일자리를 3개 채널(당근알바 / 알바몬 / 문자SMS) 각각의 형식과 톤에 딱 맞게 다시 써라.

## 공통 규칙
- 한국어. 시니어 지원자가 읽기 쉽게 쉬운 단어, 짧은 문장.
- 메모에 없는 정보를 멋대로 지어내지 마라(회사명/연락처/링크 X). 비면 자연스럽게 생략하거나 "협의" 로 둬라.
- 급여/근무지/시간/업무는 메모에서 최대한 뽑아내라.

## 채널별 형식
1) danggeun (당근알바): 동네 이웃에게 말 걸듯 친근하고 짧게. 이모지 1~2개 OK. 제목은 동네+조건 강조(예: "성수동 카페 청소 / 오전 4시간 / 시급 11,000원"). 본문 4~6줄, 군더더기 없이.
2) albamon (알바몬): 정형화된 채용 공고. 본문은 반드시 [모집부문] / [근무조건] / [자격요건] / [우대사항] / [근무지] 섹션 라벨을 대괄호로 쓰고 각 항목은 '- ' 불릿. 정중하고 사무적인 톤.
3) sms (문자): 후보에게 바로 보내는 SMS. 유니코드 이모지로 섹션 구분(📦 업무 / ⏰ 시간 / 📍 근무지 / 💰 급여 / 🙋 지원). 짧고 핵심만. 마지막 줄 "📩 관심 있으시면 이 문자에 '지원'이라고 답장 주세요."

## 출력
generate_multi_posting 도구로만 응답해라. 줄바꿈은 실제 개행(\\n).`;

export async function generateMultiPlatformPosting(
  rough: string,
  supabase?: SupabaseClient,
  // 화주사/지점 마스터에서 서버가 조회한 '검증된 사실'(집결지·시급 등). 있으면 초안에 반영한다
  // — '지어내지 마라' 규칙과 충돌 없이(제공된 사실이므로) 채널 초안 정확도를 높인다(주제 D2).
  masterContext?: string
): Promise<MultiPlatformPosting | null> {
  const apiKey = process.env.CLAUDE_API;
  if (!apiKey) {
    console.error("[claude] CLAUDE_API env missing");
    return null;
  }
  const MODEL = "claude-sonnet-4-6";

  const body = {
    model: MODEL,
    max_tokens: 3072,
    system: MULTI_PLATFORM_SYSTEM_PROMPT,
    tools: [
      {
        name: "generate_multi_posting",
        description:
          "거친 채용 메모를 당근알바/알바몬/문자SMS 3개 채널 형식으로 각각 작성해 반환합니다.",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string", description: "공통 한 줄 제목 (예: '성수동 카페 오전 청소 모집')" },
            fields: {
              type: "object",
              description: "미리보기 카드용 구조화 필드. 메모에 없으면 빈 문자열 또는 '협의'.",
              properties: {
                company: { type: "string", description: "회사/매장명. 없으면 빈 문자열." },
                location: { type: "string", description: "근무지 (예: '서울 성동구 성수동')." },
                pay: { type: "string", description: "급여 (예: '시급 11,000원')." },
                schedule: { type: "string", description: "근무 시간/요일 (예: '주 3일 오전 08:00~12:00')." },
                role: { type: "string", description: "직무 한 줄 (예: '매장 청소 및 정리')." },
                tags: {
                  type: "array",
                  items: { type: "string" },
                  description: "노출용 짧은 태그 3~5개 (예: ['시니어 우대','4대보험','당일지원']).",
                },
              },
              required: ["company", "location", "pay", "schedule", "role", "tags"],
            },
            danggeun: {
              type: "object",
              properties: {
                title: { type: "string" },
                body: { type: "string" },
              },
              required: ["title", "body"],
            },
            albamon: {
              type: "object",
              properties: {
                title: { type: "string" },
                body: { type: "string" },
              },
              required: ["title", "body"],
            },
            sms: {
              type: "object",
              properties: {
                title: { type: "string" },
                body: { type: "string" },
              },
              required: ["title", "body"],
            },
          },
          required: ["title", "fields", "danggeun", "albamon", "sms"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "generate_multi_posting" },
    messages: [
      {
        role: "user",
        content: masterContext
          ? `${rough}\n\n[검증된 마스터 사실 — 시스템이 화주사·지점 마스터에서 확인한 정보다. 초안에 반영해도 되고, 여기 없는 건 지어내지 마라]\n${masterContext}`
          : rough,
      },
    ],
  };

  // 시연 안정성: 25초 안에 응답 없으면 abort → 라우트가 목업으로 폴백.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
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
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("[claude] HTTP", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as {
      content: Array<{ type: string; name?: string; input?: MultiPlatformPosting }>;
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
    console.error("[claude] generateMultiPlatformPosting exception", err);
    return null;
  } finally {
    clearTimeout(timeout);
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
