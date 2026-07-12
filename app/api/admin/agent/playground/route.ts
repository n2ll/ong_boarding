/**
 * POST /api/admin/agent/playground
 *
 * 시뮬레이션 전용 — 실제 stage 모듈을 그대로 호출하지만
 * DB 저장 / SMS 발송 / 알림톡 발송 / transitions 부수효과는 전혀 일어나지 않는다.
 *
 * 클라이언트가 가짜 컨텍스트를 만들어 보내면 stage.process() 결과만 그대로 반환.
 *
 * 또한 transition === "advance" 시, 실제 운영에서 자동 발송될 텍스트도 미리보기로 같이 반환.
 */

import { NextRequest, NextResponse } from "next/server";
import { explorationStage } from "@/lib/agent/stages/exploration";
import { onboardingStage } from "@/lib/agent/stages/onboarding";
import { screeningStage } from "@/lib/agent/stages/screening";
import { activeStage } from "@/lib/agent/stages/active";
import {
  buildScreeningAnnouncement,
  buildOnboardingGuideText,
  buildFirstDayRules,
  buildVenueGuideText,
} from "@/lib/agent/transitions";
import {
  buildGeneralHandoffText,
  buildGeneralScreeningAnnouncement,
  GENERAL_SCREENING_AUTO_TRUE,
  isGeneralLineJob,
} from "@/lib/agent/general-line";
import { mergeAgentState } from "@/lib/agent/checklist";
import { createServiceClient } from "@/lib/supabase";
import type {
  AgentState,
  ApplicantContext,
  ConversationTurn,
  JobContext,
  Stage,
  StageContext,
  StageName,
} from "@/lib/agent/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const STAGES: Record<Exclude<StageName, "paused" | "abort">, Stage> = {
  exploration: explorationStage,
  screening: screeningStage,
  onboarding: onboardingStage,
  active: activeStage,
};

interface PlaygroundRequest {
  stage: "exploration" | "screening" | "onboarding" | "active";
  job: JobContext | null;
  applicant: ApplicantContext;
  history: ConversationTurn[];
  state: AgentState;
  inbound_text: string;
}

export async function POST(req: NextRequest) {
  let payload: PlaygroundRequest;
  try {
    payload = (await req.json()) as PlaygroundRequest;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!payload.stage || !STAGES[payload.stage]) {
    return NextResponse.json({ error: "stage 값 필수: exploration/screening/onboarding/active" }, { status: 400 });
  }
  if (!payload.applicant || !payload.applicant.phone) {
    return NextResponse.json({ error: "applicant.phone 필수" }, { status: 400 });
  }
  if (!payload.inbound_text?.trim()) {
    return NextResponse.json({ error: "inbound_text 필수" }, { status: 400 });
  }

  const stage = STAGES[payload.stage];
  const ctx: StageContext = {
    job: payload.job,
    applicant: payload.applicant,
    history: payload.history ?? [],
    state: payload.state ?? {},
  };

  const result = await stage.process(ctx, payload.inbound_text.trim());

  // 실제 운영(transitions.applyTransition)이 처리하는 자동 발송 + 자동 체크리스트 갱신을 시뮬한다.
  // Playground는 applyTransition을 부르지 않으므로, 같은 부수효과를 여기서 직접 미러링.
  const name = payload.applicant.name ?? "지원자";
  let auto_messages_preview: string[] = [];

  // (1) 단계 전이 시 자동 발송 + 자동 true 체크리스트
  const generalLine = isGeneralLineJob(payload.job);
  if (result.transition.kind === "advance") {
    if (result.transition.to === "screening") {
      auto_messages_preview = [
        generalLine ? buildGeneralScreeningAnnouncement(name) : buildScreeningAnnouncement(name),
      ];

      // exploration → screening: 안내 항목 + 조건부 항목 자동 true
      const job = payload.job;
      const slot = job?.slot ?? "";
      const screeningAuto: Record<string, boolean> = generalLine
        ? { ...(GENERAL_SCREENING_AUTO_TRUE as Record<string, boolean>) }
        : {
            프로모션_종료가능성_안내: true,
            정산주기_안내: true,
            업무시간_체계_이해: true,
          };
      if (!generalLine && job && job.vehicle_required === false) {
        screeningAuto.자차_재확인 = true;
      }
      if (!generalLine && !slot.includes("주말")) {
        screeningAuto.공휴일_업무여부_확인 = true;
      }
      result.state_update = mergeAgentState(result.state_update, {
        screening: screeningAuto,
      });
    } else if (result.transition.to === "onboarding") {
      if (generalLine) {
        // 일반 라인: 배민 앱 가이드 대신 선탑 인계 마무리 + paused 전환 (transitions와 동일)
        auto_messages_preview = [
          buildGeneralHandoffText(name),
          "ℹ️ 일반 라인 — 이후 매니저 인계(paused)로 전환되고 Slack에 수집 요약이 발송됩니다.",
        ];
      } else {
        auto_messages_preview = [buildOnboardingGuideText(name)];
        // screening → onboarding: 앱설치 교육 안내 발송됨 자동 true
        result.state_update = mergeAgentState(result.state_update, {
          onboarding: { 앱설치_교육_안내발송됨: true },
        });
      }
    } else if (result.transition.to === "active") {
      auto_messages_preview = [buildFirstDayRules(name)];
    }
  }

  // (2) 만남장소 자동 발송 — onboarding state post-process 시뮬
  // (배민 아이디 수신 & 아직 미발송 상태일 때 시스템이 자동 발송)
  if (payload.stage === "onboarding" || result.transition.kind === "advance") {
    const onb = result.state_update.onboarding;
    const willSendVenue =
      onb?.배민_아이디_수신 === true &&
      onb?.만남장소_안내발송됨 !== true;

    if (willSendVenue) {
      const job = payload.job;
      if (!job?.start_date) {
        auto_messages_preview.push("⚠️ 만남장소 자동 발송 조건 미충족: 공고에 시작일 없음");
      } else if (!job?.pickup_address) {
        auto_messages_preview.push("⚠️ 만남장소 자동 발송 조건 미충족: 공고에 픽업주소 없음");
      } else if (!job?.site_manager_id) {
        auto_messages_preview.push("⚠️ 만남장소 자동 발송 조건 미충족: 현장 매니저 미배정");
      } else {
        try {
          const supabase = createServiceClient();
          const { data: sm } = await supabase
            .from("site_managers")
            .select("name, phone")
            .eq("id", job.site_manager_id)
            .maybeSingle();
          if (sm?.name && sm?.phone) {
            auto_messages_preview.push(
              buildVenueGuideText({
                name: payload.applicant.name,
                start_date: job.start_date,
                pickup_address: job.pickup_address,
                site_manager_name: sm.name as string,
                site_manager_phone: sm.phone as string,
              })
            );
            // 만남장소 발송됨 — 다음 턴 중복 발송 방지
            result.state_update = mergeAgentState(result.state_update, {
              onboarding: { 만남장소_안내발송됨: true },
            });
          } else {
            auto_messages_preview.push("⚠️ 만남장소 자동 발송 조건 미충족: 매니저 정보 조회 실패");
          }
        } catch (e) {
          console.error("[playground] venue preview fetch failed", e);
          auto_messages_preview.push("⚠️ 만남장소 자동 발송 조건 조회 실패 (DB 오류)");
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    result,
    auto_messages_preview,
  });
}

// 자동 발송 텍스트는 lib/agent/transitions.ts 에서 import — 중복 제거
