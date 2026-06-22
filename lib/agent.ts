/**
 * 구직자 SMS 자동 답변 초안 생성
 *
 * 인입 SMS마다 Claude로 답변 초안을 만들어 message_drafts에 저장한다.
 * 자동 발송하지 않음 — 매니저가 admin UI에서 검토 후 발송.
 *
 * 대화 톤 reference: prompts/conversation-examples.txt
 *   매니저가 직접 .txt 파일을 수정하면 다음 배포부터 반영됨.
 */

import { loadConversationExamples, loadPersonaGuidance } from "./agent/examples";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export interface AgentApplicantContext {
  id: number | null;
  name: string | null;
  phone: string;
  branch1: string | null;
  branch2: string | null;
  confirmed_branch: string | null;
  current_branch: string | null;
  work_hours: string | null;
  status: string | null;
  available_date: string | null;
  own_vehicle: string | null;
  introduction: string | null;
}

export interface AgentTurn {
  direction: "inbound" | "outbound";
  body: string;
  created_at: string;
}

export interface AgentDraft {
  status: "reply" | "need_info";
  draft_text: string | null;
  reasoning: string;
  missing_info?: string;
}

const MANAGER_NAME = process.env.AGENT_MANAGER_NAME || "홍석범";
const KAKAO_CHANNEL_URL =
  process.env.NEXT_PUBLIC_KAKAO_CHANNEL_URL || "http://pf.kakao.com/_xnxaxaib";
const APPLY_URL = process.env.AGENT_APPLY_URL || "";

async function buildSystemPrompt(): Promise<string> {
  const [examples, persona] = await Promise.all([
    loadConversationExamples(),
    loadPersonaGuidance(),
  ]);
  const examplesSection = examples
    ? `\n## 실제 대화 예시 (톤·길이·스타일 참고용 — 무조건 이 톤 따라가)\n\n${examples}`
    : "";
  // 운영자 추가 지침 — 위의 안전 규칙(need_info 등)은 그대로 두고 톤·세부만 우선 반영.
  const personaSection = persona
    ? `\n\n## 운영자 추가 지침 (관리자 설정 — 안전 규칙은 유지하되 아래 톤·세부 지침을 우선 반영)\n${persona}`
    : "";
  return SYSTEM_PROMPT_BODY + examplesSection + personaSection;
}

const SYSTEM_PROMPT_BODY = `너는 옹고잉(내이루리) 비마트 배송원 채용 매니저 "${MANAGER_NAME}"의 SMS 응대를 돕는 에이전트다.
구직자가 보낸 문자에 대한 답변 초안을 생성한다. 자동 발송되지 않으니 자연스럽고 정확하게.

## 톤·스타일
- 친근하면서도 매니저답게. 호칭은 "[이름]님" 또는 "[이름] 선생님".
- 짧게. 보통 1~2문장. 이모지 ㅎㅎ ㅠㅠ ^^ :) 적절히 (남발 금지).
- 이미 자기소개를 한 대화면 다시 자기소개하지 마라.
- 첫 메시지(처음 보내는 outbound)면: "안녕하세요 [이름]님. 비마트 [지점] 배송 담당 매니저 ${MANAGER_NAME}입니다." 형태로 시작.

## 사실 정확성 (중요)
다음 구체 사실은 **공고(있을 경우) 또는 applicant 컨텍스트**에 있는 값만 사용해라. 절대 지어내지 마라:
- 시급/시간대/근무지 주소/지점 위치/시작일/인근 지하철역/필요 차량

답변 가능한 정보 우선순위:
1. [현재 진행 중인 구인공고] 섹션이 있으면 거기에 명시된 사실 그대로 인용 가능
2. [지원자 컨텍스트]의 applicant 필드 값
3. 위 둘 다에 없는 사실 → status: "need_info"

## 🚨 즉시 need_info (= 매니저 인계, AI 응답 중단)
다음 신호 중 하나라도 보이면 reply 시도하지 말고 status="need_info"로 매니저에게 넘겨라.
**중요: need_info를 선택하면 draft_text는 null. 어떤 사과·중간 멘트도 보내지 마라.**
시스템이 슬랙으로 알리고 매니저가 직접 응대한다. AI가 한마디 더 보태면 상황이 꼬인다.

신호:
1. **수치/단가 구체 질문** — "프로모션 없는 건당 배송수당", "시급 정확히 얼마", "기본 단가",
   "주말 수당" 등 금액·계산식·수당 구조 질문. 공고에 명시 안 된 수치는 절대 추측 X.
2. **항의·법적 표현** — "불법", "고소", "신고", "공정위", "노동청", "지원 취소",
   "지원서 폐기", "환불", "조치 취해" — 한 단어라도 등장하면 즉시 need_info.
3. **반복 재촉 + 짜증** — "답변 없으니", "왜 안 답해", "이딴 식으로" 같은 격화된 표현.
4. **공고 정당성 시비** — "사전고지 없는 모집 광고는…" 식으로 공고 적법성을 따지면 need_info.
5. **계약/세금/보험** — 4대보험, 사업자, 원천징수, 계약서, 산재 질문은 need_info.

missing_info에 한 줄로 신호를 적어라.
예: missing_info: "지원자가 '지원 취소', '불법' 언급 — 수당 단가 질문에서 항의로 전환"

## need_info 사용 가이드 (남발 금지)
need_info는 "구체 사실을 물어봤는데 답을 모를 때"만 쓴다.
다음 경우에는 **need_info 쓰지 말고 reply로 응대**해라:

- 일반 인사/지원 문의 ("안녕하세요", "지원하고 싶어요", "비마트 알아보고 있어요") → 환영 + 지원 폼 안내
- 컨텍스트가 비어 있어도(applicant 정보 없음 = 신규/모르는 번호) 일반 응대는 가능. 다음 톤으로:
  "안녕하세요! 비마트 배송 관심 가져주셔서 감사합니다. 옹고잉 지원 폼에서 간단한 정보 작성해주시면 가장 가까운 지점 티오 생길 때 연락드릴게요 :) [지원 폼 URL]"
  (지원 폼 URL이 환경에 없으면 "지원 폼" 또는 "카카오 채널"로 안내)
- 단순 마무리 인사 ("감사합니다", "수고하세요") → "네 감사합니다 선생님!" 같이 자연스럽게
- 통화 요청 ("통화 가능하세요?") → "네 잠시 후 전화 드리겠습니다 :)" 정도 짧게

## 컨텍스트가 비어 있을 때 (이름·지점 모두 null)
신규 또는 미등록 번호에서 온 문자다. 호칭은 "선생님" 또는 생략하고, 지원 폼/카카오 채널로 유도하는 답변을 만들어라. need_info로 매니저를 부르지 마라 — 일반 안내는 에이전트가 처리할 수 있다.

## 안내 링크
- 지원 폼: ${APPLY_URL || "(매니저에게 직접 문의 안내)"}
- 카카오 채널: ${KAKAO_CHANNEL_URL}

## 출력
draft_reply tool로만 응답:
- status: "reply" — 정상 답변 가능 → draft_text에 답변
- status: "need_info" — 컨텍스트에 없는 사실관계 질문 → draft_text는 null, missing_info에 무엇이 모자란지 한국어로 (예: "시급, 인근 지하철역")

reasoning에는 왜 그렇게 답변했는지 한 줄로 설명 (예: "이미 자기소개 끝남, 시간 질문에 work_hours로 답변").`;

function formatApplicant(a: AgentApplicantContext): string {
  const parts: string[] = [];
  parts.push(`이름: ${a.name || "(없음)"}`);
  parts.push(`전화: ${a.phone}`);
  if (a.branch1) parts.push(`1지망 지점: ${a.branch1}`);
  if (a.branch2) parts.push(`2지망 지점: ${a.branch2}`);
  if (a.confirmed_branch) parts.push(`확정 지점: ${a.confirmed_branch}`);
  if (a.current_branch) parts.push(`현재 근무 지점: ${a.current_branch}`);
  if (a.work_hours) parts.push(`희망 시간대: ${a.work_hours}`);
  if (a.status) parts.push(`상태: ${a.status}`);
  if (a.available_date) parts.push(`근무 가능일: ${a.available_date}`);
  if (a.own_vehicle) parts.push(`차량 보유: ${a.own_vehicle}`);
  return parts.join("\n");
}

function formatHistory(turns: AgentTurn[]): string {
  if (turns.length === 0) return "(이전 대화 없음 — 첫 응대)";
  return turns
    .map((t) => {
      const role = t.direction === "inbound" ? "구직자" : "에이전트";
      return `${role}: ${t.body}`;
    })
    .join("\n");
}

export async function generateDraftReply(input: {
  applicant: AgentApplicantContext;
  history: AgentTurn[];
  latestInbound: string;
  jobPosting?: string | null;
}): Promise<AgentDraft | null> {
  const apiKey = process.env.CLAUDE_API;
  if (!apiKey) {
    console.error("[agent] CLAUDE_API env missing");
    return null;
  }

  const postingSection = input.jobPosting?.trim()
    ? `[현재 진행 중인 구인공고 — 이 공고에 대한 응대다. 시급·시간·지점 등은 여기서 인용해 답변 가능]
${input.jobPosting.trim()}

`
    : "";

  const userContent = `${postingSection}[지원자 컨텍스트]
${formatApplicant(input.applicant)}

[지금까지의 대화]
${formatHistory(input.history)}

[방금 받은 구직자 메시지]
${input.latestInbound}

위 메시지에 대한 답변 초안을 draft_reply tool로 생성해라.`;

  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: await buildSystemPrompt(),
    tools: [
      {
        name: "draft_reply",
        description:
          "구직자 SMS에 대한 답변 초안을 반환합니다. 사실관계가 모호하면 need_info로.",
        input_schema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["reply", "need_info"],
              description:
                "정상 답변이 가능하면 'reply', 컨텍스트에 없는 정보가 필요하면 'need_info'.",
            },
            draft_text: {
              type: ["string", "null"],
              description:
                "발송할 답변문 (reply일 때 필수, need_info면 null). 한국어, 짧게(1~3문장).",
            },
            reasoning: {
              type: "string",
              description: "이 답변을 선택한 이유 한 줄 설명 (한국어).",
            },
            missing_info: {
              type: "string",
              description:
                "need_info일 때 무엇이 모자란지 (예: '시급, 인근 지하철역'). reply면 빈 문자열.",
            },
          },
          required: ["status", "reasoning"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "draft_reply" },
    messages: [{ role: "user", content: userContent }],
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
      console.error("[agent] HTTP", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as {
      content: Array<{ type: string; input?: AgentDraft }>;
    };
    const block = data.content?.find((c) => c.type === "tool_use");
    if (!block?.input) {
      console.error("[agent] no tool_use block");
      return null;
    }
    return block.input;
  } catch (err) {
    console.error("[agent] exception", err);
    return null;
  }
}
