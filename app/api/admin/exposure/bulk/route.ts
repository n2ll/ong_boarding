/**
 * J · 타겟 공고 노출 — 수동 오버라이드 일괄 배정.
 *
 * POST   : { job_ids: number[], applicant_ids: number[], mode: 'include'|'exclude',
 *            make_targeted?: boolean, flip_job_ids?: number[], rule_action?: 'keep'|'clear', rule_jobs?: number[] }
 *          flip_job_ids·rule_jobs는 **호출부가 확인 화면에서 실제로 보여준 공고 스냅샷**이다.
 *          낡은 화면이 확인 없이 다른 공고를 좁히거나 규칙을 지우는 것을 막는다(전환은 교집합만, clear는 409).
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
import { normalizeRule, writeExposureProtectRows } from "@/lib/exposure";
import { EXPOSURE_JOB_GEO_COLUMNS, jobSupportsRadius, type GeoJob } from "@/lib/geo";

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
    .select(`id, title, exposure, exposure_rule, recruit_mode, ${EXPOSURE_JOB_GEO_COLUMNS}`)
    .in("id", jobIds);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ({
    id: number;
    title: string;
    exposure: string | null;
    exposure_rule: unknown;
    recruit_mode: string | null;
  } & GeoJob)[];
  return rows.filter((j) => !isSystemJobTitle(j.title));
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

  // 전환 대상 — 호출부가 확인 화면에서 **실제로 보여준 공고만**(flip_job_ids) 전환한다.
  // 화면 캐시가 낡아 '이미 지정 노출'로 알고 있던 공고를 확인 없이 좁히면 안 된다
  // (전환되지 않은 공고는 아래 non_targeted로 알려 재시도할 수 있다).
  // 스냅샷이 없으면 전환하지 않는다(fail-closed) — 배포 전 번들이나 다른 호출부가 make_targeted만 보내면
  // 확인 화면을 거치지 않은 공고까지 좁아진다. 전환이 안 된 사실은 아래 non_targeted로 알려 재시도 가능하다.
  const flipAllowed = new Set(parseIds(body?.flip_job_ids));
  const flipJobs = makeTargeted
    ? jobs.filter(
        (j) =>
          j.exposure !== "targeted" &&
          flipAllowed.has(j.id) &&
          // external(새로 모집)은 맞춤 공고 링크에 애초에 뜨지 않는다(pool GET이 internal·both만 노출).
          // targeted로 바꾸면 명단은 효력이 없고, 공개 지원 링크의 후보 연결만 끊긴다.
          j.recruit_mode !== "external" &&
          // 유지될 규칙에 반경이 있는데 기준점(좌표)이 없으면 전환하지 않는다 —
          // 전환되는 순간 그 규칙은 아무도 통과 못 해, 수정 모달의 쓰기 가드가 막는 상태를 여기로 우회해 만들게 된다.
          !(ruleAction !== "clear" && normalizeRule(j.exposure_rule)?.radiusKm && !jobSupportsRadius(j))
      )
    : [];
  const skippedFlipNoGeo = makeTargeted
    ? jobs
        .filter(
          (j) =>
            j.exposure !== "targeted" &&
            flipAllowed.has(j.id) &&
            j.recruit_mode !== "external" &&
            ruleAction !== "clear" &&
            normalizeRule(j.exposure_rule)?.radiusKm &&
            !jobSupportsRadius(j)
        )
        .map((j) => j.id)
    : [];
  const skippedFlipExternal = makeTargeted
    ? jobs.filter((j) => j.exposure !== "targeted" && j.recruit_mode === "external").map((j) => j.id)
    : [];

  // 화면이 본 규칙 스냅샷(rule_jobs)과 DB가 어긋나면 막는다 — 'clear'는 확인 창에 한 줄도 안 뜬 규칙이
  // 되돌릴 수 없이 사라지고, 'keep'은 매니저가 모르는 규칙이 그대로 남아 고르지 않은 사람이 함께 본다.
  // 두 방향 모두 조용해서, 선택 종류와 무관하게 같은 기준으로 막고 현황을 다시 읽게 한다.
  if (ruleAction !== undefined && withRule.length > 0) {
    const seen = new Set(parseIds(body?.rule_jobs));
    const unseen = withRule.filter((j) => !seen.has(j.id));
    if (unseen.length > 0) {
      return NextResponse.json(
        {
          error: "화면을 연 뒤 규칙이 바뀐 공고가 있어요 — 현황을 다시 읽고 확인해 주세요.",
          code: "rule_snapshot_stale",
          jobs_with_rule: unseen.map((j) => ({ id: j.id, title: j.title })),
        },
        { status: 409 }
      );
    }
  }

  // 노출이 좁아지는 공고 = 전체→지정 전환 대상 ∪ 규칙 삭제 대상.
  const clearJobs = ruleAction === "clear" ? withRule : [];
  const narrowingIds = [...new Set([...flipJobs, ...clearJobs].map((j) => j.id))];

  // 1) 이미 이 공고로 연결된 분·안내 문자를 받은 분을 먼저 명단에 남긴다 —
  //    전환보다 **먼저** 써야 노출이 끊기는 순간이 없다. 판정은 lib/exposure의 단일 공식.
  let autoIncluded = 0;
  if (narrowingIds.length > 0) {
    const { inserted, error: protectErr } = await writeExposureProtectRows(supabase, narrowingIds);
    if (protectErr) {
      console.error("[exposure bulk] linked protect failed", protectErr);
      return NextResponse.json(
        { error: "이미 연결된 인원을 명단에 남기지 못했어요 — 아무것도 바꾸지 않았습니다." },
        { status: 500 }
      );
    }
    autoIncluded = inserted;
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

  // 5) 전환·규칙 삭제 뒤 한 번 더 — 1)의 읽기와 전환 사이엔 아직 '전체 노출'이라 관심 클릭이
  //    게이트를 통과해 후보 행 + AI 첫 문자가 생긴다. 전환 후에는 interest가 fail-closed라
  //    새 행이 생기지 않으므로 이 2차 패스가 창을 닫는다. 실패해도 이미 적용된 변경은 유지(non-fatal).
  if (narrowingIds.length > 0) {
    const { inserted: late, error: lateErr } = await writeExposureProtectRows(supabase, narrowingIds);
    if (lateErr) console.error("[exposure bulk] late protect failed", lateErr);
    else autoIncluded += late;
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
    // 전환하지 않은 external 공고 — 조용한 부분 성공으로 보이지 않게 호출부가 알린다.
    skipped_flip_external: skippedFlipExternal,
    // 반경 규칙이 있는데 집결지 좌표가 없어 전환하지 않은 공고 — 호출부가 이유를 말해준다.
    skipped_flip_no_geo: skippedFlipNoGeo,
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
