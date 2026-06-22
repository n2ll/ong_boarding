/**
 * POST /api/admin/agent/set-stage
 *
 * 매니저가 후보의 agent_stage를 수동으로 변경한다.
 * 이전 단계 체크리스트는 자동으로 모두 true 처리 — "그 단계까지 완료한 것으로 가정"하고 진행.
 * 다음 인입부터 새 stage 모듈이 동작한다.
 *
 * body: { applicant_id: number, target_stage: 'screening' | 'onboarding' | 'active' }
 *
 * 동작:
 *  - target='screening': 그대로 진입 (checklist 변경 없음)
 *  - target='onboarding': screening 8항목 모두 true → onboarding 진입 (앱설치 안내 자동 발송 등 transitions의 advance 부수효과 그대로)
 *  - target='active': screening 8 + onboarding 4 모두 true → active 진입 (첫출근 룰 자동 발송)
 *  - 같은 stage 재지정은 no-op
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { applyTransition } from "@/lib/agent/transitions";
import { SCREENING_KEYS, ONBOARDING_KEYS, mergeAgentState } from "@/lib/agent/checklist";
import type {
  AgentState,
  JobContext,
  OnboardingChecklist,
  ScreeningChecklist,
  StageName,
} from "@/lib/agent/types";

export const dynamic = "force-dynamic";

const ALLOWED: StageName[] = ["screening", "onboarding", "active"];

export async function POST(req: NextRequest) {
  try {
    const { applicant_id, target_stage } = await req.json();
    if (!applicant_id || !target_stage) {
      return NextResponse.json({ error: "applicant_id와 target_stage는 필수입니다." }, { status: 400 });
    }
    if (!ALLOWED.includes(target_stage as StageName)) {
      return NextResponse.json({ error: `허용 stage: ${ALLOWED.join(", ")}` }, { status: 400 });
    }

    const supabase = createServiceClient();

    // 활성 job_candidate + 관련 정보 로드
    const { data: jc } = await supabase
      .from("job_candidates")
      .select(`
        id, job_id, applicant_id, agent_stage, agent_state,
        jobs:job_id ( id, title, body, branch, slot, start_date, vehicle_required, pickup_address, site_manager_id ),
        applicants:applicant_id ( id, name, phone, branch1, work_hours, source )
      `)
      .eq("applicant_id", applicant_id)
      .not("agent_stage", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!jc) {
      return NextResponse.json({ error: "활성 job_candidate를 찾을 수 없습니다." }, { status: 404 });
    }

    const currentStage = jc.agent_stage as StageName;
    const targetStage = target_stage as StageName;

    if (currentStage === targetStage) {
      return NextResponse.json({ ok: true, noop: true, message: "이미 해당 단계입니다." });
    }

    // 이전 단계 체크리스트를 모두 true로 채우는 state_update 구성
    const screeningAllTrue: ScreeningChecklist = SCREENING_KEYS.reduce((acc, k) => {
      acc[k] = true;
      return acc;
    }, {} as ScreeningChecklist);
    const onboardingAllTrue: OnboardingChecklist = ONBOARDING_KEYS.reduce((acc, k) => {
      acc[k] = true;
      return acc;
    }, {} as OnboardingChecklist);

    const stateUpdate: AgentState = {
      meta: {
        ...((jc.agent_state as AgentState | null)?.meta ?? {}),
        manual_stage_set_at: new Date().toISOString(),
        manual_stage_set_from: currentStage,
      },
    };
    if (targetStage === "onboarding" || targetStage === "active") {
      stateUpdate.screening = screeningAllTrue;
    }
    if (targetStage === "active") {
      stateUpdate.onboarding = onboardingAllTrue;
    }

    const applicant = jc.applicants as unknown as {
      id: number; name: string | null; phone: string;
      branch1: string | null; work_hours: string | null; source: string | null;
    };
    const job = (jc.jobs ?? null) as unknown as JobContext | null;
    const simulate = applicant.source === "danggeun_practice";

    // '확정'(active)으로 수동 전환 시엔 자동 발송·부수효과 없이 stage/체크리스트/status만 갱신.
    // (첫 출근 룰 등은 매니저가 별도로 진행)
    if (targetStage === "active") {
      const prev = (jc.agent_state ?? {}) as AgentState;
      const merged = mergeAgentState(prev, stateUpdate);
      const { error: upErr } = await supabase
        .from("job_candidates")
        .update({ agent_stage: "active", agent_state: merged })
        .eq("id", jc.id);
      if (upErr) {
        console.error("[agent/set-stage] active update error", upErr);
        return NextResponse.json({ error: upErr.message }, { status: 500 });
      }
      // '스크리닝 완료' 단계로 자동 갱신 (매니저가 이미 확정인력/대기자/부적합 설정했으면 건드리지 않음).
      // 매니저가 통화 후 '확정인력'으로 직접 변경하는 흐름.
      await supabase
        .from("applicants")
        .update({ status: "스크리닝 완료" })
        .eq("id", applicant.id)
        .in("status", ["스크리닝 전", "스크리닝 중", "스크리닝 완료"]);
      return NextResponse.json({
        ok: true,
        from_stage: currentStage,
        to_stage: "active",
        auto_sent_messages: 0,
      });
    }

    // screening / onboarding 전환은 기존대로 applyTransition을 태워 자동 발송·status 업데이트 포함.
    const apply = await applyTransition({
      supabase,
      candidate_id: jc.id as number,
      applicant_id: applicant.id,
      applicant_name: applicant.name,
      applicant_phone: applicant.phone,
      applicant_branch: applicant.branch1 ?? null,
      applicant_work_hours: applicant.work_hours ?? null,
      job_id: jc.job_id as number,
      job,
      current_stage: currentStage,
      state_update: stateUpdate,
      transition: { kind: "advance", to: targetStage, reason: "매니저 수동 단계 변경" },
      simulate,
    });

    return NextResponse.json({
      ok: true,
      from_stage: currentStage,
      to_stage: apply.next_stage,
      auto_sent_messages: apply.auto_sent_messages,
    });
  } catch (err) {
    console.error("[agent/set-stage] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
