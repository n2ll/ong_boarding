/**
 * J · 타겟 공고 노출 — 수동 오버라이드 일괄 배정.
 *
 * POST   : { job_ids: number[], applicant_ids: number[], mode: 'include'|'exclude',
 *            make_targeted?: boolean, rule_action?: 'keep'|'clear' }
 *          선택 인원 × 선택 공고 조합을 job_exposure_targets에 upsert(같은 조합은 mode 갱신).
 *          파이프라인에서 필터·세그먼트로 고른 인원을 여러 공고에 한 번에 배정하는 핵심 동선.
 *          make_targeted=true면 전체 노출 공고를 '지정 노출'로 전환까지 한 번에(원클릭).
 *          rule_action은 저장된 자동 노출 규칙 처리 — 'keep'(규칙 두고 명단 추가) / 'clear'(규칙 삭제).
 * DELETE : { job_ids, applicant_ids } — 해당 조합의 오버라이드 행 삭제(규칙 판정으로 복귀).
 *
 * 대상 공고는 실공고(비시스템)만. 지정 노출(targeted)이 아닌 공고에도 기록은 허용하되
 * 응답에 non_targeted로 알려준다(먼저 사람을 골라두고 나중에 공고를 targeted로 바꾸는 순서 지원).
 * 어드민 미들웨어 인증.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { isSystemJobTitle } from "@/lib/jobs";
import { normalizeRule } from "@/lib/exposure";

export const dynamic = "force-dynamic";

const MAX_PAIRS = 5000; // 500명 × 10공고 상한 — 폭주 방지

function parseIds(v: unknown): number[] {
  return Array.isArray(v)
    ? [...new Set(v.map(Number).filter((n) => Number.isFinite(n) && n > 0))]
    : [];
}

async function loadValidJobs(supabase: ReturnType<typeof createServiceClient>, jobIds: number[]) {
  const { data, error } = await supabase
    .from("jobs")
    .select("id, title, exposure, exposure_rule")
    .in("id", jobIds);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { id: number; title: string; exposure: string | null; exposure_rule: unknown }[];
  return rows.filter((j) => !isSystemJobTitle(j.title));
}

/**
 * 노출이 좁아지는 공고에서 **이미 이 공고로 연결된 분**(관심 클릭·후보)을 명단에 남긴다.
 *
 * 왜: 노출 게이팅은 후보 여부를 보지 않는다(pool GET·interest·notify 모두 isExposed만 본다).
 * 그래서 전체→지정 전환이나 규칙 삭제로 이분들이 규칙에서 빠지면, 이야기 중인 공고가 본인 화면에서
 * 그냥 사라진다 — AI는 그 공고를 응대하는데 지원자는 볼 수 없는 상태가 된다.
 * 이탈(abort)만 제외하고, stage가 NULL인 '관심만 누른 분'은 반드시 포함한다(가장 보호가 필요한 집단).
 * 이미 오버라이드 행이 있는 사람은 건드리지 않는다 — 매니저가 명시적으로 제외한 사람을 되살리면 안 된다.
 */
async function protectLinkedApplicants(
  supabase: ReturnType<typeof createServiceClient>,
  jobIds: number[]
): Promise<{ rows: { job_id: number; applicant_id: number; mode: string; added_by: string }[]; error?: string }> {
  if (jobIds.length === 0) return { rows: [] };

  const linked = new Map<number, Set<number>>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("job_candidates")
      .select("job_id, applicant_id")
      .in("job_id", jobIds)
      .or("agent_stage.is.null,agent_stage.neq.abort")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) return { rows: [], error: error.message };
    const batch = data ?? [];
    for (const r of batch) {
      const row = r as { job_id: number; applicant_id: number | null };
      if (typeof row.applicant_id !== "number") continue;
      const s = linked.get(row.job_id) ?? new Set<number>();
      s.add(row.applicant_id);
      linked.set(row.job_id, s);
    }
    if (batch.length < 1000) break;
  }
  if (linked.size === 0) return { rows: [] };

  const existing = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("job_exposure_targets")
      .select("job_id, applicant_id")
      .in("job_id", jobIds)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) return { rows: [], error: error.message };
    const batch = data ?? [];
    for (const r of batch) {
      const row = r as { job_id: number; applicant_id: number };
      existing.add(`${row.job_id}:${row.applicant_id}`);
    }
    if (batch.length < 1000) break;
  }

  const rows: { job_id: number; applicant_id: number; mode: string; added_by: string }[] = [];
  for (const [jobId, set] of linked) {
    for (const applicantId of set) {
      if (existing.has(`${jobId}:${applicantId}`)) continue;
      rows.push({ job_id: jobId, applicant_id: applicantId, mode: "include", added_by: "auto_linked" });
    }
  }
  return { rows };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const jobIds = parseIds(body?.job_ids);
  const applicantIds = parseIds(body?.applicant_ids);
  const mode = body?.mode;
  if (jobIds.length === 0 || applicantIds.length === 0) {
    return NextResponse.json({ error: "job_ids와 applicant_ids가 필요합니다." }, { status: 400 });
  }
  if (mode !== "include" && mode !== "exclude") {
    return NextResponse.json({ error: "mode: 'include' | 'exclude'" }, { status: 400 });
  }
  const makeTargeted = body?.make_targeted === true;
  const ruleAction = body?.rule_action;
  if (ruleAction !== undefined && ruleAction !== "keep" && ruleAction !== "clear") {
    return NextResponse.json({ error: "rule_action: 'keep' | 'clear'" }, { status: 400 });
  }
  // 노출을 좁히는 조작(전환·규칙 삭제)은 '노출 제외'와 함께 오면 안 된다 —
  // 제외 명단만 있는 상태로 지정 노출로 바꾸면 그 공고가 아무에게도 안 보인다.
  if ((makeTargeted || ruleAction === "clear") && mode !== "include") {
    return NextResponse.json(
      { error: "노출 방식 전환·규칙 삭제는 '노출 추가'에서만 할 수 있습니다." },
      { status: 400 }
    );
  }
  if (jobIds.length * applicantIds.length > MAX_PAIRS) {
    return NextResponse.json({ error: `조합이 너무 많습니다(최대 ${MAX_PAIRS}).` }, { status: 400 });
  }

  const supabase = createServiceClient();
  let jobs;
  try {
    jobs = await loadValidJobs(supabase, jobIds);
  } catch (e) {
    console.error("[exposure bulk] jobs load failed", e);
    return NextResponse.json({ error: "공고 조회 실패" }, { status: 500 });
  }
  if (jobs.length === 0) {
    return NextResponse.json({ error: "대상 실공고가 없습니다." }, { status: 400 });
  }

  // 저장된 자동 노출 규칙이 있는 공고에 명단을 추가할 때는 규칙 처리를 **명시**해야 한다.
  // 특히 전체 노출 공고에 예전 규칙이 남아 있는 경우, 노출 방식만 바꾸면 매니저가 고르지 않은
  // '규칙 해당 인원'에게도 공고가 함께 보인다(조용한 확대). 호출부가 2택을 반드시 묻게 하는 서버 가드.
  const withRule = jobs.filter((j) => normalizeRule(j.exposure_rule) !== null);
  if (mode === "include" && withRule.length > 0 && ruleAction === undefined) {
    return NextResponse.json(
      {
        error: "자동 노출 규칙이 있는 공고예요 — 규칙을 둘지 지울지 선택해야 합니다.",
        code: "rule_action_required",
        jobs_with_rule: withRule.map((j) => ({ id: j.id, title: j.title })),
      },
      { status: 400 }
    );
  }

  // 존재하는 지원자만 — 삭제된 id가 섞이면 FK 위반으로 배치 전체가 죽는다.
  const { data: appRows, error: appErr } = await supabase
    .from("applicants")
    .select("id")
    .in("id", applicantIds);
  if (appErr) {
    console.error("[exposure bulk] applicants check failed", appErr);
    return NextResponse.json({ error: "지원자 확인 실패" }, { status: 500 });
  }
  const validApplicantIds = (appRows ?? []).map((r) => (r as { id: number }).id);
  if (validApplicantIds.length === 0) {
    return NextResponse.json({ error: "대상 지원자가 없습니다." }, { status: 400 });
  }

  // 노출이 좁아지는 공고 = 전체→지정 전환 대상 ∪ 규칙 삭제 대상.
  const flipJobs = makeTargeted ? jobs.filter((j) => j.exposure !== "targeted") : [];
  const clearJobs = ruleAction === "clear" ? withRule : [];
  const narrowingIds = [...new Set([...flipJobs, ...clearJobs].map((j) => j.id))];

  // 1) 이미 이 공고로 연결된 분을 먼저 명단에 남긴다 — 전환보다 **먼저** 써야 노출이 끊기는 순간이 없다.
  let autoIncluded = 0;
  if (narrowingIds.length > 0) {
    const { rows: protectRows, error: protectErr } = await protectLinkedApplicants(supabase, narrowingIds);
    if (protectErr) {
      console.error("[exposure bulk] linked protect failed", protectErr);
      return NextResponse.json(
        { error: "이미 연결된 인원 확인에 실패했어요 — 아무것도 바꾸지 않았습니다." },
        { status: 500 }
      );
    }
    if (protectRows.length > 0) {
      const { error: protectInsErr } = await supabase.from("job_exposure_targets").insert(protectRows);
      if (protectInsErr) {
        console.error("[exposure bulk] linked protect insert failed", protectInsErr);
        return NextResponse.json(
          { error: "이미 연결된 인원을 명단에 남기지 못했어요 — 아무것도 바꾸지 않았습니다." },
          { status: 500 }
        );
      }
      autoIncluded = protectRows.length;
    }
  }

  const rows = jobs.flatMap((j) =>
    validApplicantIds.map((aid) => ({ job_id: j.id, applicant_id: aid, mode, added_by: "manager" }))
  );
  // 2) 매니저가 고른 명단 — 같은 (job,applicant) 조합이 이미 있으면 mode를 덮어쓴다(include↔exclude 전환).
  //    앞의 자동 보호는 insert(기존 행 보존)인데 이건 upsert다 — 명시적 선택이 자동 판단을 이긴다.
  const { error } = await supabase
    .from("job_exposure_targets")
    .upsert(rows, { onConflict: "job_id,applicant_id" });
  if (error) {
    console.error("[exposure bulk] upsert failed", error);
    return NextResponse.json({ error: "배정 실패" }, { status: 500 });
  }

  // 3) 노출 방식 전환 → 4) 규칙 삭제. 이 순서라야 첫 실패 시 공고가 하나도 안 바뀐 상태로 남아
  //    깔끔하게 재시도할 수 있다(규칙만 지워지고 전환은 안 된 어중간한 상태 방지).
  const flippedIds = flipJobs.map((j) => j.id);
  if (flippedIds.length > 0) {
    const { error: flipErr } = await supabase
      .from("jobs")
      .update({ exposure: "targeted" })
      .in("id", flippedIds);
    if (flipErr) {
      console.error("[exposure bulk] flip to targeted failed", flipErr);
      return NextResponse.json(
        { error: "명단은 저장했지만 '지정 노출' 전환에 실패했어요 — 공고 수정에서 노출 방식을 바꿔 주세요.", partial: true },
        { status: 500 }
      );
    }
  }
  const clearedIds = clearJobs.map((j) => j.id);
  if (clearedIds.length > 0) {
    const { error: clearErr } = await supabase
      .from("jobs")
      .update({ exposure_rule: null })
      .in("id", clearedIds);
    if (clearErr) {
      console.error("[exposure bulk] rule clear failed", clearErr);
      return NextResponse.json(
        { error: "명단·전환은 됐지만 규칙 삭제가 실패했어요 — 공고 수정에서 규칙을 비워 주세요(지금은 규칙 해당 인원에게도 보입니다).", partial: true },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({
    success: true,
    mode,
    pairs: rows.length,
    jobs: jobs.map((j) => ({ id: j.id, title: j.title })),
    // 전환한 공고는 이제 지정 노출이라 non_targeted에서 빠진다(전환 후 남은 '효력 없는' 공고만 알린다).
    non_targeted: jobs
      .filter((j) => j.exposure !== "targeted" && !flippedIds.includes(j.id))
      .map((j) => j.id),
    flipped: flippedIds,
    rule_cleared: clearedIds,
    auto_included: autoIncluded,
    // 걸러진 것들 — 조용한 부분 성공으로 보이지 않게 명시(호출부가 안내 표시).
    skipped_applicants: applicantIds.length - validApplicantIds.length,
    skipped_jobs: jobIds.length - jobs.length,
  });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const jobIds = parseIds(body?.job_ids);
  const applicantIds = parseIds(body?.applicant_ids);
  if (jobIds.length === 0 || applicantIds.length === 0) {
    return NextResponse.json({ error: "job_ids와 applicant_ids가 필요합니다." }, { status: 400 });
  }
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("job_exposure_targets")
    .delete()
    .in("job_id", jobIds)
    .in("applicant_id", applicantIds);
  if (error) {
    console.error("[exposure bulk] delete failed", error);
    return NextResponse.json({ error: "해제 실패" }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
