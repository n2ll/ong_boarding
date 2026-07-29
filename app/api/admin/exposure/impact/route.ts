/**
 * GET /api/admin/exposure/impact?job_ids=1,2,3
 *
 * 파이프라인 '노출 대상 지정'의 확인 화면용 — 공고별로 "지금 어떻게 노출되고 있고, 바꾸면 누가 영향을 받는지"를
 * 한 번에 계산한다. 공고마다 /api/admin/jobs/[id]/exposure를 부르면 인재풀 전량 로드가 공고 수만큼 반복된다.
 *
 * 이 응답이 반드시 알려야 하는 두 가지(둘 다 조용히 지나가면 사고가 된다):
 *  1) **전체 노출 공고에 남아 있는 예전 규칙** — 노출 방식만 '지정'으로 바꾸면 매니저가 고르지 않은
 *     '규칙 해당 인원'에게도 공고가 함께 보인다(의도치 않은 확대).
 *  2) **이미 이 공고와 연결된 인원 수** — 전환·규칙 삭제로 이분들이 노출을 잃으면, 이야기 중인 공고가
 *     본인 화면에서 사라진다(AI는 그 공고를 이야기하는데 지원자는 볼 수 없는 상태).
 *
 * 어드민 미들웨어 인증.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import {
  describeRule,
  fetchApplicantsForExposure,
  gatherExposureProtectTargets,
  matchesRule,
  normalizeRule,
} from "@/lib/exposure";
import { isSystemJobTitle } from "@/lib/jobs";
import { EXPOSURE_JOB_GEO_COLUMNS, jobSupportsRadius, type GeoJob } from "@/lib/geo";

export const dynamic = "force-dynamic";

const MAX_JOBS = 50;

export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get("job_ids") ?? "";
  const ids = [
    ...new Set(
      raw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ].slice(0, MAX_JOBS);
  if (ids.length === 0) {
    return NextResponse.json({ error: "job_ids가 필요합니다." }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: jobRows, error: jobErr } = await supabase
    .from("jobs")
    .select(`id, title, exposure, exposure_rule, recruit_mode, ${EXPOSURE_JOB_GEO_COLUMNS}`)
    .in("id", ids);
  if (jobErr) {
    console.error("[exposure impact] jobs load failed", jobErr);
    return NextResponse.json({ error: "공고 조회 실패" }, { status: 500 });
  }
  const jobs = (jobRows ?? []).filter(
    (j) => !isSystemJobTitle((j as { title: string }).title)
  ) as { id: number; title: string; exposure: string | null; exposure_rule: unknown; recruit_mode: string | null }[];
  if (jobs.length === 0) {
    return NextResponse.json({ error: "대상 실공고가 없습니다." }, { status: 400 });
  }
  const jobIds = jobs.map((j) => j.id);

  // 오버라이드·연결 인원은 페이지네이션으로 전량 — PostgREST 기본 상한(1000)에 걸려 잘리면
  // '이미 명단에 N명'이 실제보다 작게 보이고, 매니저가 명단 규모를 잘못 판단한다.
  const includeCount = new Map<number, number>();
  const excludeCount = new Map<number, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("job_exposure_targets")
      .select("job_id, mode")
      .in("job_id", jobIds)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error("[exposure impact] overrides load failed", error);
      return NextResponse.json({ error: "노출 오버라이드 조회 실패" }, { status: 500 });
    }
    const batch = data ?? [];
    for (const r of batch) {
      const row = r as { job_id: number; mode: string };
      const m = row.mode === "exclude" ? excludeCount : includeCount;
      m.set(row.job_id, (m.get(row.job_id) ?? 0) + 1);
    }
    if (batch.length < 1000) break;
  }

  // 연결 인원 = **노출을 좁힐 때 서버가 실제로 명단에 남기는 집합**과 같은 공식으로 센다.
  // 여기서 후보만 세면 확인 창의 '이미 연결된 N명'이 실제 pin 집합보다 작게 나온다
  // (그 공고 안내 문자를 받은 분이 빠진다) — 같은 개념 두 공식 금지.
  const { linked, error: linkedErr } = await gatherExposureProtectTargets(supabase, jobIds);
  if (linkedErr) {
    console.error("[exposure impact] linked load failed", linkedErr);
    return NextResponse.json({ error: "연결 인원 조회 실패" }, { status: 500 });
  }

  let pool;
  try {
    pool = await fetchApplicantsForExposure(supabase);
  } catch (e) {
    console.error("[exposure impact] pool load failed", e);
    return NextResponse.json({ error: "인재풀 조회 실패" }, { status: 500 });
  }
  const now = Date.now();

  return NextResponse.json({
    total_pool: pool.length,
    jobs: jobs.map((j) => {
      const rule = normalizeRule(j.exposure_rule);
      const labels = describeRule(rule);
      return {
        id: j.id,
        title: j.title,
        exposure: j.exposure === "targeted" ? "targeted" : "all",
        // 맞춤 공고 링크에 실제로 뜨는 공고인가 — pool GET은 recruit_mode in ('internal','both')만 노출한다.
        // false면 '전체 노출 = 인재풀 전원에게 보임'이 거짓이고, 노출 명단도 효력이 없다.
        pull_exposed: j.recruit_mode === "internal" || j.recruit_mode === "both",
        rule_conditions: labels.length,
        rule_labels: labels,
        // 지금 규칙에 해당하는 인원 — '규칙 두고 추가'와 '규칙 지우고 명단만'의 차이를 숫자로 보여준다.
        // 반경 축은 공고 기준점이 필요하다 — 공고를 함께 넘기지 않으면 fail-closed로 0명이 된다.
        rule_matched: rule ? pool.filter((a) => matchesRule(a, rule, { nowMs: now, job: j as unknown as GeoJob })).length : 0,
        include_count: includeCount.get(j.id) ?? 0,
        exclude_count: excludeCount.get(j.id) ?? 0,
        linked: linked.get(j.id)?.size ?? 0,
      };
    }),
  });
}
