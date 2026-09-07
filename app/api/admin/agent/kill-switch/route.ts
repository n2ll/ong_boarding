/**
 * GET  /api/admin/agent/kill-switch
 *   → { mode: 'auto'|'draft'|'off', disabled: boolean, updated_at, env_forced }
 * POST /api/admin/agent/kill-switch
 *   body: { mode: 'draft'|'off' } 또는 { mode: 'test', phone, job_ids }.
 *   → GET과 같은 완전한 상태 snapshot. 클라이언트가 환경 강제 중지를 임의 추정하지 않게 한다.
 *   구형 전체 재개(auto/disabled:false)는 409. disabled:true는 OFF.
 *
 * 전역 AI 응답 모드를 prompt_examples(category='system_message', title='agent_kill_switch')
 * 'draft'=초안만, '1'=OFF, 검수 JSON=제한된 새 인입. 구형 '0'과 빈 설정도 OFF.
 * router.runAgentForCandidate가 처리 시작 전 getAgentMode()로 이 값을 확인한다.
 *
 * 주의: 환경변수 AGENT_DISABLED=1이 별도로 걸려 있으면 이 토글과 무관하게 항상 중단된다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { invalidateKillSwitchCache, isValidTestJobIds, parseAgentMode, parseAgentTestSession, type AgentMode } from "@/lib/agent/kill-switch";
import { AGENT_KILL_SWITCH_CATEGORY, AGENT_KILL_SWITCH_TITLE } from "@/lib/admin/prompt-example-reserved";

export const dynamic = "force-dynamic";

const CATEGORY = AGENT_KILL_SWITCH_CATEGORY;
const TITLE = AGENT_KILL_SWITCH_TITLE;

const MODE_TO_BODY: Record<AgentMode, string> = { auto: "0", draft: "draft", off: "1" };

export async function GET() {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("prompt_examples")
      .select("body, updated_at")
      .eq("category", CATEGORY)
      .eq("title", TITLE)
      .limit(2);

    if (error) {
      console.error("[kill-switch GET]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if ((data?.length ?? 0) > 1) {
      console.error("[kill-switch GET] duplicate control rows detected");
      return NextResponse.json({ error: "AI 응답 모드 저장 상태가 중복되어 확인이 필요합니다." }, { status: 409 });
    }

    const stored = data?.[0];
    const mode = parseAgentMode(stored?.body as string | null | undefined);
    return NextResponse.json({
      mode,
      test_session: process.env.AGENT_DISABLED === "1" ? null : parseAgentTestSession(stored?.body),
      // 하위호환 — 기존 소비자(disabled boolean)는 '완전 중지'일 때만 true.
      disabled: mode === "off",
      updated_at: (stored as { updated_at?: string } | undefined)?.updated_at ?? null,
      env_forced: process.env.AGENT_DISABLED === "1",
    });
  } catch (err) {
    console.error("[kill-switch GET exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json()) as { mode?: unknown; disabled?: unknown; phone?: unknown; job_ids?: unknown };

    let mode: AgentMode;
    const testing = payload.mode === "test";
    if (testing) {
      mode = "off";
    } else if (payload.mode !== undefined) {
      if (payload.mode !== "auto" && payload.mode !== "draft" && payload.mode !== "off") {
        return NextResponse.json(
          { error: "mode는 'auto' | 'draft' | 'off' 중 하나여야 합니다." },
          { status: 400 }
        );
      }
      mode = payload.mode;
    } else if (typeof payload.disabled === "boolean") {
      // 구형 on/off 불리언 요청 하위호환
      mode = payload.disabled ? "off" : "auto";
    } else {
      return NextResponse.json(
        { error: "mode('auto'|'draft'|'off') 또는 disabled(boolean)가 필요합니다." },
        { status: 400 }
      );
    }

    // 구형 UI/스크립트의 전체 재개 요청도 실제 저장 전에 차단한다.
    if (mode === "auto") return NextResponse.json({ error: "전체 자동 응대는 잠겨 있습니다. 공고와 테스트 대상을 선택해 제한 검수를 사용해주세요." }, { status: 409 });
    if (testing && !isValidTestJobIds(payload.job_ids)) return NextResponse.json({ error: "검수할 공고를 1~3개 선택해주세요." }, { status: 400 });
    const supabase = createServiceClient();
    let body = MODE_TO_BODY[mode];
    const updatedAt = new Date().toISOString();
    if (testing) {
      if (process.env.AGENT_DISABLED === "1") return NextResponse.json({ error: "환경 강제 중지 중에는 검수를 시작할 수 없습니다." }, { status: 409 });
      const phone = typeof payload.phone === "string" ? payload.phone.replace(/[^0-9]/g, "") : "";
      if (!/^01[0-9]{8,9}$/.test(phone)) return NextResponse.json({ error: "테스트 계정의 휴대전화 번호를 입력해주세요." }, { status: 400 });
      const { data: targets, error: targetError } = await supabase.from("applicants").select("id,name,sms_opt_out_at").eq("phone", phone).limit(2);
      if (targetError) return NextResponse.json({ error: "테스트 대상 조회 실패" }, { status: 500 });
      const target = targets?.length === 1 ? targets[0] : null;
      if (!target || !/테스트|test/i.test(target.name ?? "") || target.sms_opt_out_at) {
        return NextResponse.json({ error: "이름에 테스트 표시가 있고 수신거부하지 않은 단일 기존 계정만 검수할 수 있습니다." }, { status: 400 });
      }
      const jobIds = payload.job_ids as number[];
      const { data: jobs, error: jobsError } = await supabase.from("jobs").select("id,title,status,closes_at").in("id", jobIds);
      if (jobsError) return NextResponse.json({ error: "검수 공고 조회 실패" }, { status: 500 });
      if (jobs?.length !== jobIds.length || jobs.some((job) => !job.title?.trim() || job.title.startsWith("__") || job.status !== "active"
        || (job.closes_at != null && !(Date.parse(job.closes_at) > Date.now())))) {
        return NextResponse.json({ error: "모집 중인 실제 공고만 검수할 수 있습니다." }, { status: 400 });
      }
      body = JSON.stringify({ mode: "test", applicant_id: target.id, job_ids: jobIds, started_at: updatedAt, expires_at: new Date(Date.now() + 20 * 60_000).toISOString() });
    }

    // update-first + 부분 유니크 인덱스로 최초 생성 경쟁에서도 예약 행을 하나만 유지한다.
    const { data: updatedRows, error: updateError } = await supabase
      .from("prompt_examples")
      .update({ body, updated_at: updatedAt })
      .eq("category", CATEGORY)
      .eq("title", TITLE)
      .select("body, updated_at");
    if (updateError) {
      console.error("[kill-switch POST update]", updateError);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    if ((updatedRows?.length ?? 0) > 1) {
      console.error("[kill-switch POST] duplicate control rows detected");
      return NextResponse.json({ error: "AI 응답 모드 저장 상태가 중복되어 확인이 필요합니다." }, { status: 409 });
    }

    let stored = updatedRows?.[0] as { body?: string; updated_at?: string } | undefined;
    if (!stored) {
      const { data: inserted, error: insertError } = await supabase
        .from("prompt_examples")
        .insert({ category: CATEGORY, title: TITLE, body, sort_order: 0, updated_at: updatedAt })
        .select("body, updated_at")
        .single();

      if (!insertError) {
        stored = inserted as { body?: string; updated_at?: string };
      } else if (insertError.code === "23505") {
        // 다른 요청이 같은 순간 최초 행을 만들었다. 그 행에 이 요청을 마지막 쓰기로 반영한다.
        const { data: retried, error: retryError } = await supabase
          .from("prompt_examples")
          .update({ body, updated_at: updatedAt })
          .eq("category", CATEGORY)
          .eq("title", TITLE)
          .select("body, updated_at")
          .single();
        if (retryError) {
          console.error("[kill-switch POST retry]", retryError);
          return NextResponse.json({ error: retryError.message }, { status: 500 });
        }
        stored = retried as { body?: string; updated_at?: string };
      } else {
        console.error("[kill-switch POST insert]", insertError);
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
    }

    // 이 인스턴스의 캐시만 즉시 무효화(best-effort). 다른 인스턴스도 TTL 5초 내 반영됨.
    invalidateKillSwitchCache();
    const storedMode = parseAgentMode(stored?.body);
    return NextResponse.json({
      mode: storedMode,
      test_session: process.env.AGENT_DISABLED === "1" ? null : parseAgentTestSession(stored?.body),
      disabled: storedMode === "off",
      env_forced: process.env.AGENT_DISABLED === "1",
      updated_at: stored?.updated_at ?? updatedAt,
    });
  } catch (err) {
    console.error("[kill-switch POST exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
