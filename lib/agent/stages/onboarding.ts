/**
 * Stage: onboarding
 *
 * screening → onboarding 전이 직후, 시스템이 자동으로 앱설치·교육 안내(GUIDE)를 발송한다
 * (transitions.ts의 부수효과). 그 이후 지원자 회신을 받아 배민 커넥트 아이디를 수집한다.
 *
 * 체크리스트 (3항목):
 *   - 앱설치_교육_안내발송됨    : 진입 시 GUIDE 발송 성공하면 자동 true (transitions.ts에서)
 *   - 배민_아이디_수신          : 지원자 회신에서 추출
 *   - 만남장소_안내발송됨       : 현재 미사용 — 만남장소 자동 발송/D-day cron 미구현 (매니저 수동)
 *
 * 배민_아이디_수신 시 → advance: active. 단 active는 자동 단계 전이일 뿐 매니저 확정이 아니다.
 */

import { emptyOnboarding, isComplete, mergeAgentState } from "../checklist";
import { buildToneGuide } from "../examples";
import { sendSlackOnboardingReady } from "../../slack";
import { handoffToolProperties, HANDOFF_EMIT_RULE } from "../handoff-category";
import type {
  OnboardingChecklist,
  Stage,
  StageContext,
  StageResult,
} from "../types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MANAGER_NAME = process.env.AGENT_MANAGER_NAME || "홍석범";

const SYSTEM_PROMPT_BODY = `너는 옹고잉 비마트 배송원 채용 매니저 "${MANAGER_NAME}"의 SMS 응대 에이전트다.
지금은 "온보딩(정보 수집)" 단계 — 사전 확인을 끝낸 지원자에게서 배민 커넥트 아이디만 수집한다.

## ⚠️ 가장 중요한 원칙 — 확정 뉘앙스 절대 금지
지원자가 정보를 보내도 그게 곧 근무 확정/배정을 의미하지 않는다.
"근무 진행", "곧 시작합니다" 류의 확정 멘트 금지. 매니저가 별도로 확정한다.

## 진입 직후 자동 발송 (이미 시스템이 보냄)
"안녕하세요? 업무 진행을 위한 앱설치 및 요청사항을 전달 드립니다.
1. 배민 커넥트 앱 설치 후 가입
2. 안전보건교육 영상(2시간) 필수 시청
3. 마이페이지 > 내정보의 '아이디' 회신 부탁드립니다
[가입/사용법 가이드 영상 링크]"

## 너의 목표
지원자 회신에서 **배민 커넥트 아이디**만 수집한다.
- 배민_아이디_수신: 지원자가 답장에 배민 커넥트 ID(영문/숫자)를 보냈는가

## 처리 흐름
- **아이디 받으면** → "감사합니다! 확인되었습니다. 곧 담당 매니저가 연락드리겠습니다 :)" 톤으로 마무리.
  (이후 만남장소 안내·확정 등은 매니저가 직접 진행한다. 너가 일시·장소·매니저 정보를 적지 마라.)
  ⚠️ 이 마무리 멘트는 **'이번 턴에 처음' 아이디가 채워졌을 때 단 한 번만** 보낸다.
- **아이디가 아직 없으면** → "마이페이지 > 내정보에서 아이디 확인 후 회신 부탁드릴게요!" 정도로 짧게 안내.
- ⚠️ 차량번호는 묻지 마라. 시스템이 더 이상 수집 안 함.

## 수집 완료(아이디 수신) 이후의 인입 — 답장 금지가 기본
[현재 체크리스트]에 배민_아이디_수신이 **이미 ✓**라면 AI 할 일은 끝났고 마무리 인사도 했다.
- **정보 재전송·단순 감사·확인** (아이디 다시 보냄, "네", "감사합니다", "ㅇㅋ" 등)
  → reply_text **빈 문자열** + stay. **절대 다시 답장하지 마라**.
- **일정 변경/취소/문제 보고** ("못 갈 것 같아요" 등)
  → reply_text **빈 문자열** + transition: pause (사유: "수집 완료 후 변경 요청 — 매니저 응대").
- **새 정보 질문** (시작일·위치·매니저 재확인 등) → 짧게 답변 후 stay.

## 톤
친근하고 짧게. 1~2문장. 호칭은 "[이름]님" 또는 "선생님".

## 사실 정확성 (엄격)
- 시작일·만남장소·매니저 연락처 등 **모든 수치/사실은 [현재 공고]·시스템 데이터에서만** 인용.
- 공고/시스템에 없는 정보는 **절대 추측·임의 생성 금지**.

## 단계 전이
- "stay": 아직 아이디 미수신이거나 일반 질문 응대 중
- "pause": 지원자가 앱설치/영상 시청에 어려움 또는 정책 질문 등 매니저 도움 필요
- "abort": 지원자가 명시적 포기 의사

(advance: active 전이는 시스템이 아이디 수신 시점에 자동 처리 — AI가 transition으로 명시할 필요 없음)

## 체크리스트 갱신
지원자 회신에서 명시적으로 받은 정보만 true로:
- **영문·숫자가 섞인 짧은 문자열(2~30자)이 메시지 어딘가에 단독 줄로 들어 있으면** → 배민_아이디_수신: true 로 확정 + baemin_id_text에 그 문자열 그대로 담아라.
- 한국어 문장에 섞여 있어도, 그 안에 영문+숫자 토큰이 있으면 그것이 배민 아이디일 가능성 매우 높음 → 추출.
- 예시 (모두 ID로 처리):
  - "miyoung0804"   → baemin_id_text="miyoung0804"
  - "아이디 eugene0909 입니다" → baemin_id_text="eugene0909"
  - "tpwlsdms1"     → baemin_id_text="tpwlsdms1"
  - "kim_delivery"  → baemin_id_text="kim_delivery"
- 영문 없이 한국어만이면 ID 아님. 핸드폰번호 형식(01x-xxxx-xxxx)도 ID 아님.

## 출력
onboarding_turn tool로만 응답.`;

async function buildSystemPrompt(branchName?: string | null): Promise<string> {
  return `${SYSTEM_PROMPT_BODY}\n${HANDOFF_EMIT_RULE}\n\n${await buildToneGuide(branchName)}`;
}

/**
 * 배민 커넥트 아이디 유효성 판정.
 *
 * 조건: 2~30자, 영문 1자 이상 포함, [A-Za-z0-9._-]만 허용.
 * 제외: 핸드폰번호형(0으로 시작 10~11자리), 순수 숫자만.
 * (영문만으로 된 아이디 'kim_delivery'도 허용 — 숫자 필수 아님)
 */
export function isValidBaeminId(t: string): boolean {
  if (!t) return false;
  if (t.length < 2 || t.length > 30) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(t)) return false;   // 허용 문자만
  if (!/[A-Za-z]/.test(t)) return false;            // 영문 1자 이상
  if (/^0\d{9,10}$/.test(t)) return false;          // 핸드폰번호형 제외
  if (/^\d+$/.test(t)) return false;                // 순수 숫자만 제외
  return true;
}

/**
 * 인입 텍스트에서 배민 커넥트 아이디로 보이는 토큰을 추출 (AI가 놓치는 경우 백업).
 */
export function detectBaeminIdFallback(text: string): string {
  // 라인/공백 단위로 토큰 분리 후 후보 추출
  const tokens = text.split(/[\s,;:|/()[\]{}<>"'`]+/).filter(Boolean);
  for (const raw of tokens) {
    const t = raw.replace(/[.!?,。、~^]+$/, ""); // 끝 구두점 제거
    if (/^https?$/i.test(t)) continue;
    if (isValidBaeminId(t)) return t;
  }
  return "";
}

interface OnboardingToolInput {
  reply_text: string;
  checklist_update: Partial<OnboardingChecklist>;
  baemin_id_text?: string;
  transition: "stay" | "pause" | "abort";
  transition_reason: string;
  handoff_category?: string;
  suggested_action?: string;
  reasoning: string;
}

const TOOL = {
  name: "onboarding_turn",
  description:
    "온보딩 단계의 한 턴 처리 — 응답문, 체크리스트 갱신, 전이 시그널 반환.",
  input_schema: {
    type: "object" as const,
    properties: {
      reply_text: {
        type: "string",
        description: "지원자에게 보낼 답변. 한국어 1~2문장.",
      },
      checklist_update: {
        type: "object",
        description: "이번 턴에 새로 true가 된 항목만.",
        properties: {
          앱설치_교육_안내발송됨: { type: "boolean" },
          배민_아이디_수신: { type: "boolean" },
          만남장소_안내발송됨: { type: "boolean" },
        },
      },
      baemin_id_text: {
        type: "string",
        description:
          "지원자가 보낸 배민 커넥트 아이디 원본 텍스트. 영문/숫자만. 없으면 빈 문자열. (예: 'eugene0909', 'tpwlsdms1')",
      },
      transition: {
        type: "string",
        enum: ["stay", "pause", "abort"],
      },
      transition_reason: {
        type: "string",
      },
      ...handoffToolProperties,
      reasoning: {
        type: "string",
      },
    },
    required: ["reply_text", "checklist_update", "transition", "reasoning"],
  },
};

function formatChecklist(state: StageContext["state"]): string {
  const cl = { ...emptyOnboarding(), ...(state.onboarding ?? {}) };
  return Object.entries(cl)
    .map(([k, v]) => `  ${v ? "✓" : "☐"} ${k}`)
    .join("\n");
}

function formatHistory(history: StageContext["history"]): string {
  if (history.length === 0) return "(이전 대화 없음)";
  return history
    .map((t) => `${t.direction === "inbound" ? "구직자" : "에이전트"}: ${t.body}`)
    .join("\n");
}

export const onboardingStage: Stage = {
  name: "onboarding",

  async process(ctx: StageContext, inboundText: string): Promise<StageResult> {
    const apiKey = process.env.CLAUDE_API;
    if (!apiKey) return failResult("CLAUDE_API env missing");

    const userContent = `[현재 공고]
${ctx.job ? `${ctx.job.title}\n시작일: ${ctx.job.start_date ?? "-"} / 지점: ${ctx.job.branch ?? "-"}` : "(공고 없음)"}

[지원자]
${ctx.applicant.name ?? ""} (${ctx.applicant.phone})

[현재 체크리스트]
${formatChecklist(ctx.state)}

[지금까지의 대화]
${formatHistory(ctx.history)}

[방금 받은 메시지]
${inboundText}

onboarding_turn tool로 응답해라.`;

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
          max_tokens: 768,
          system: await buildSystemPrompt(ctx.applicant.branch1 ?? ctx.job?.branch ?? null),
          tools: [TOOL],
          tool_choice: { type: "tool", name: "onboarding_turn" },
          messages: [{ role: "user", content: userContent }],
        }),
        cache: "no-store",
      });
      if (!res.ok) {
        console.error("[onboarding] HTTP", res.status, await res.text());
        return failResult(`Claude HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        content: Array<{ type: string; input?: OnboardingToolInput }>;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      };
      const block = data.content?.find((c) => c.type === "tool_use");
      if (!block?.input) return failResult("no tool_use block");

      const result = toStageResult(block.input, ctx);
      result.usage = { model: MODEL, ...(data.usage ?? {}) };

      // AI가 추출한 배민 아이디 텍스트 + 결정론적 백업 추출(AI가 놓치는 경우 대비).
      // 1) AI가 baemin_id_text를 채웠으면 우선 사용
      // 2) 비어 있으면 인입 텍스트에서 영문+숫자 토큰을 직접 스캔
      let idText = (block.input.baemin_id_text || "").trim();
      if (!idText) {
        idText = detectBaeminIdFallback(inboundText);
      }
      const validId = isValidBaeminId(idText);
      if (validId) {
        result.applicant_patch = { ...(result.applicant_patch ?? {}), baemin_id: idText };
        // AI가 체크리스트를 놓쳤어도 강제로 마킹
        const after = result.state_update.onboarding ?? {};
        if (!after.배민_아이디_수신) {
          result.state_update = {
            ...result.state_update,
            onboarding: { ...after, 배민_아이디_수신: true },
          };
        }
      } else if (result.state_update.onboarding?.배민_아이디_수신 && !ctx.applicant.baemin_id) {
        // AI가 '아이디 수신' 플래그를 켰지만 유효 토큰이 없고 기존 저장 ID도 없다 →
        // 플래그를 되돌리고 매니저 인계. (NULL baemin_id인 채 조용히 active로 넘어가는 원버그 차단)
        const reverted = { ...(result.state_update.onboarding ?? {}) };
        delete reverted.배민_아이디_수신;
        result.state_update = { ...result.state_update, onboarding: reverted };
        result.transition = {
          kind: "pause",
          reason: "배민 아이디 수신으로 판단됐으나 유효한 아이디를 추출하지 못함 — 매니저 확인 필요",
        };
      }

      // 배민 아이디가 '이번 턴에 처음' 유효하게 확보된 시점:
      //  1) 슬랙 '준비 완료' 알림
      //  2) AI 마무리 멘트("감사합니다 곧 매니저가...") 그대로 발송
      //  3) 자동으로 active 단계로 advance → applicants.status='스크리닝 완료'
      // 트리거 기준은 AI 체크리스트 플래그가 아니라 '실제 patch된 유효 baemin_id'.
      const alreadyHadId = !!ctx.applicant.baemin_id;
      const firstTimeId = validId && !alreadyHadId;
      if (firstTimeId) {
        try {
          await sendSlackOnboardingReady({
            applicant_name: ctx.applicant.name,
            applicant_phone: ctx.applicant.phone,
            branch: ctx.applicant.branch1 ?? ctx.job?.branch ?? null,
            work_hours: ctx.applicant.work_hours ?? null,
          });
        } catch (e) {
          console.error("[onboarding] slack onboarding-ready failed", e);
        }
        // 자동 확정 — abort/pause가 아니면 active로 강제 advance.
        if (result.transition.kind === "stay") {
          result.transition = {
            kind: "advance",
            to: "active",
            reason: "온보딩 정보 수집 완료 — 자동 확정",
          };
        }
      }

      return result;
    } catch (e) {
      console.error("[onboarding] exception", e);
      return failResult(e instanceof Error ? e.message : "unknown");
    }
  },
};

function toStageResult(out: OnboardingToolInput, ctx: StageContext): StageResult {
  const state_update = mergeAgentState(ctx.state, {
    onboarding: out.checklist_update,
    meta: {
      last_run_at: new Date().toISOString(),
      last_reasoning: out.reasoning,
    },
  });

  let transition: StageResult["transition"];
  switch (out.transition) {
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

  // onboarding → active 전이는 process()에서 유효 baemin_id 최초 확보 시 자동 처리(AI 결정 X).
  // 3항목 모두 true면 메타에 완료 시각 표시(참고용).
  if (isComplete(state_update, "onboarding")) {
    state_update.meta = { ...(state_update.meta ?? {}), onboarding_complete_at: new Date().toISOString() };
  }

  // 배민 아이디 수신 시 AI가 "감사합니다, 곧 다시 연락드리겠습니다" 마무리 멘트를
  // 직접 보낸다 (현 설계). 이후 만남장소 안내·확정은 매니저가 직접 진행하므로 시스템 자동 발송은 없다.
  //
  // 중복 마무리 방지 가드: 이번 턴 '시작 시점'에 이미 둘 다 수신돼 있었다면 마무리 인사는 이미 보낸 상태다.
  // (재전송·감사 등으로 또 들어온 인입) → reply_text를 강제로 비워 동일 마무리 멘트 중복 발송을 막는다.
  // transition은 그대로 둬서 문제 보고 시 pause(매니저 알림)는 정상 동작.
  const before = ctx.state.onboarding ?? {};
  const alreadyCollected = !!before.배민_아이디_수신;
  const reply_text = alreadyCollected ? null : out.reply_text;

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
    state_update: { meta: { last_reasoning: `onboarding 실패: ${reason}` } },
    transition: { kind: "pause", reason: `에이전트 호출 실패: ${reason}` },
    reasoning: `onboarding 호출 실패 (${reason}) — 매니저 인계`,
  };
}
