/**
 * Stage: active
 *
 * 근무 진행 중 일반 응대. 기존 lib/agent.ts 의 generateDraftReply 를 그대로 활용한다.
 * (스크리닝/온보딩 같은 체크리스트 진행 X — 자유 대화)
 *
 * 단축 가드: 직전 AI 발화가 '마무리/대기 안내'였는데 지원자가 짧은 ack("네", "감사합니다" 등)만 보낸 경우
 * AI 호출 자체를 건너뛰고 침묵(reply_text=null + stay)으로 응대한다. 무한 인사 핑퐁 방지.
 */

import { generateDraftReply } from "../../agent";
import type { Stage, StageContext, StageResult } from "../types";

// "네", "넵", "예", "알겠", "감사", "확인", "좋", "ㅇㅋ", "굿" 등으로만 이뤄진 짧은 응답
const SHORT_ACK_RE = /^(네+|넵+|예+|알겠어?요?\.?!?|감사(합니다|해요)?[.!?]?|땡큐|굿|ㅇㅋ|확인(요|했어요|했습니다)?|좋아요|좋습니다)[.\s!~^♡♥:)\)ㅎㅋㅠㅜ]*$/i;
function isShortAck(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 14) return false;
  return SHORT_ACK_RE.test(t);
}

// 마무리/대기 톤의 outbound — "기다려주세요", "확인되는 대로", "안내드릴게요" 등
const CLOSING_RE = /(기다려|확인되는?\s*대로|확인되면|확인 후|안내드릴|연락드릴|연락 드릴|곧 연락|매니저가 연락|진행할게요|진행하겠|확인하고|확인 후 |감사합니다.{0,8}$)/;
function wasClosingMessage(text: string): boolean {
  return CLOSING_RE.test(text);
}

export const activeStage: Stage = {
  name: "active",

  async process(ctx: StageContext, inboundText: string): Promise<StageResult> {
    // 가드: 직전 AI 마무리 후 단순 ack → 침묵
    const lastOutbound = [...ctx.history].reverse().find((t) => t.direction === "outbound");
    if (lastOutbound && wasClosingMessage(lastOutbound.body) && isShortAck(inboundText)) {
      return {
        reply_text: null,
        state_update: {
          meta: {
            last_reasoning: "마무리 후 단순 ack — 응답 생략 (active 가드)",
            last_run_at: new Date().toISOString(),
          },
        },
        transition: { kind: "stay" },
        reasoning: "마무리 멘트 직후 단순 ack — 침묵으로 응대",
      };
    }

    const draft = await generateDraftReply({
      applicant: {
        id: ctx.applicant.id,
        name: ctx.applicant.name,
        phone: ctx.applicant.phone,
        branch1: ctx.applicant.branch1,
        branch2: ctx.applicant.branch2,
        confirmed_branch: ctx.job?.branch ?? null,
        current_branch: ctx.job?.branch ?? null,
        work_hours: ctx.applicant.work_hours,
        status: "스크리닝 완료",
        available_date: ctx.applicant.available_date,
        own_vehicle: ctx.applicant.own_vehicle,
        introduction: ctx.applicant.introduction,
      },
      history: ctx.history,
      latestInbound: inboundText,
      jobPosting: ctx.job?.body ?? null,
    });

    if (!draft) {
      return {
        reply_text: null,
        state_update: { meta: { last_reasoning: "active: Claude 호출 실패" } },
        transition: { kind: "pause", reason: "에이전트 호출 실패 — 매니저 인계" },
        reasoning: "active 호출 실패",
      };
    }

    if (draft.status === "need_info") {
      return {
        reply_text: null,
        state_update: { meta: { last_reasoning: draft.reasoning } },
        transition: { kind: "pause", reason: draft.missing_info || "정보 부족" },
        reasoning: draft.reasoning,
      };
    }

    return {
      reply_text: draft.draft_text,
      state_update: { meta: { last_run_at: new Date().toISOString(), last_reasoning: draft.reasoning } },
      transition: { kind: "stay" },
      reasoning: draft.reasoning,
    };
  },
};
