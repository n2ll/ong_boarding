/**
 * GET   /api/admin/jobs/[id]   — 공고 상세 (counts 포함)
 * PATCH /api/admin/jobs/[id]   — 공고 수정 (본문/정원/상태)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { geocodeAddressWithFallback } from "@/lib/kakao-geocode";
import { normalizeRule, writeExposureProtectRows } from "@/lib/exposure";
import { DISTANCE_BASIS_VALUES, EXPOSURE_JOB_GEO_COLUMNS, jobSupportsRadius, type GeoJob } from "@/lib/geo";

const ALLOWED_PATCH_FIELDS = new Set([
  "title",
  "body",
  "branch",
  "branch_id",
  // 화주사 — 잘못 귀속된 공고를 수정 모달에서 바로잡을 수 있게(예전엔 허용 목록에 없어 조용히 무시됐다).
  "client_id",
  "slot",
  "start_date",
  "vehicle_required",
  "pickup_address",
  "pickup_lat",
  "pickup_lng",
  "dropoff_address",
  "dropoff_lat",
  "dropoff_lng",
  "pay_info",
  "policy_notes",
  "pay_type",
  "pay_amount",
  "ai_facts",
  "capacity",
  "status",
  "recruit_mode",
  "site_manager_id",
  "work_period",
  "closes_at",
  // J 타겟 노출 — 노출 범위(all/targeted) + 자동 노출 규칙(jsonb)
  "exposure",
  "exposure_rule",
  // 거리 기준점 — 라인마다 집결지·경유지 관계가 달라 공고마다 고른다(lib/geo).
  "distance_basis",
]);

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: job, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  }

  // 후보 stage 카운트
  const { data: cands } = await supabase
    .from("job_candidates")
    .select("agent_stage")
    .eq("job_id", id);
  const counts: Record<string, number> = {};
  for (const c of cands ?? []) {
    const k = (c.agent_stage as string | null) ?? "sent";
    counts[k] = (counts[k] ?? 0) + 1;
  }

  return NextResponse.json({ job, counts });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_PATCH_FIELDS.has(k)) update[k] = v;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "변경할 필드가 없습니다." }, { status: 400 });
  }
  if ("client_id" in update && update.client_id !== null && typeof update.client_id !== "number") {
    return NextResponse.json({ error: "client_id 값이 잘못되었습니다." }, { status: 400 });
  }
  if (
    typeof update.status === "string" &&
    !["active", "closed", "paused"].includes(update.status)
  ) {
    return NextResponse.json({ error: "status 값이 잘못되었습니다." }, { status: 400 });
  }
  // slot(근무시간) — 길이만 검증. 4-슬롯 enum 강제는 제거: internal 정기 라인은 자유 텍스트로
  // 근무시간을 입력하고(PR #74 UI), 비마트/배민 라인은 UI가 select로 4-슬롯을 제약하므로
  // 서버 enum 검증은 internal 등록을 막기만 했다(막다른 길). (값은 표시용 문자열.)
  if (typeof update.slot === "string" && update.slot.length > 80) {
    return NextResponse.json({ error: "근무시간이 너무 깁니다(최대 80자)." }, { status: 400 });
  }
  if (update.slot === "") update.slot = null;
  if (
    "distance_basis" in update &&
    (typeof update.distance_basis !== "string" ||
      !(DISTANCE_BASIS_VALUES as readonly string[]).includes(update.distance_basis))
  ) {
    // 문자열 검사만 하면 숫자·null이 통과해 DB CHECK 제약에서 500이 난다(그때는 보호 행이 이미 쓰였다).
    return NextResponse.json({ error: "distance_basis 값이 잘못되었습니다." }, { status: 400 });
  }
  if (
    typeof update.recruit_mode === "string" &&
    !["external", "internal", "both"].includes(update.recruit_mode)
  ) {
    return NextResponse.json({ error: "recruit_mode 값이 잘못되었습니다." }, { status: 400 });
  }
  if (
    typeof update.pay_type === "string" &&
    update.pay_type !== "" &&
    !["건당", "일당", "주급", "월급", "혼합", "협의"].includes(update.pay_type)
  ) {
    return NextResponse.json({ error: "pay_type 값이 잘못되었습니다." }, { status: 400 });
  }
  if (
    "exposure" in update &&
    (typeof update.exposure !== "string" || !["all", "targeted"].includes(update.exposure))
  ) {
    return NextResponse.json({ error: "exposure 값이 잘못되었습니다." }, { status: 400 });
  }
  // exposure_rule — 알 수 없는 키·타입은 정규화로 제거해 저장(쓰레기 규칙이 노출 판정을 오염하지 않게).
  // 단 '내용이 있는데' 전부 무효(예: sido가 배열 아닌 문자열)면 기존 규칙을 조용히 지우는 대신 400 —
  // 형식 오류가 200 OK로 규칙 소거가 되면 안 된다. null/{}는 정상적인 '규칙 없음'.
  if ("exposure_rule" in update) {
    const raw = update.exposure_rule;
    const normalized = normalizeRule(raw);
    const rawHasContent =
      raw != null && (typeof raw !== "object" || Object.keys(raw as Record<string, unknown>).length > 0);
    if (normalized === null && rawHasContent) {
      return NextResponse.json({ error: "exposure_rule 형식이 잘못되었습니다." }, { status: 400 });
    }
    update.exposure_rule = normalized;
  }
  if (update.pay_type === "") update.pay_type = null;
  if (
    typeof update.work_period === "string" &&
    update.work_period !== "" &&
    !["하루", "단기", "정기"].includes(update.work_period)
  ) {
    return NextResponse.json({ error: "work_period 값이 잘못되었습니다." }, { status: 400 });
  }
  if (update.work_period === "") update.work_period = null;

  // 마감 처리 — closed로 바뀌면 closed_at 자동 기록, 재개 시 해제
  if (update.status === "closed") {
    update.closed_at = new Date().toISOString();
  } else if (update.status === "active" || update.status === "paused") {
    update.closed_at = null;
  }

  const supabase = createServiceClient();

  // 지점(branch_id) 변경 시 지점 이름·소속 화주사를 함께 맞춰 계층 정합성 유지.
  // 수정 모달에 화주사 셀렉트가 생겼고(잘못 귀속 바로잡기) 클라이언트가 화주사에 안 맞는 지점 선택을 미리 해제하므로,
  // 서버까지 온 불일치는 데이터 상태로 보고 '지점 기준'으로 정합화한다(저장을 막지 않는다).
  if (typeof update.branch_id === "number") {
    const { data: b, error: bErr } = await supabase
      .from("branches")
      .select("name, client_id")
      .eq("id", update.branch_id)
      .maybeSingle();
    // 조회 실패·없는 지점이면 계층 채움만 건너뛴다 — 저장 자체를 막지 않는다.
    // (지점이 지워진 옛 공고의 제목 수정까지 막히면 손댈 방법이 없어진다.)
    if (!bErr && b) {
      // 지점이 정해지면 이름·소속 화주사는 **지점 기준**으로 맞춘다.
      // 전송된 client_id와 어긋나면 지점을 신뢰한다 — 한 지점은 한 화주사 소속이고,
      // 어긋남은 대개 '지점의 화주사를 나중에 바꾼' 데이터 상태다. 400으로 막으면 그 지점의 모든 공고가
      // 제목 한 글자도 못 고치는 상태가 된다(수정 모달이 client_id를 항상 전송하므로).
      update.branch = (b.name as string) ?? update.branch ?? null;
      // 지점에 소속 화주사가 있을 때만 역채움 — 소속이 비어 있는 지점(화주사 삭제 등)에 붙은 공고가
      // 제목만 고쳐도 화주사 귀속을 잃는 것을 막는다.
      if (typeof b.client_id === "number") update.client_id = b.client_id;
    }
  } else if (update.branch_id === null) {
    // 지점 연결을 끊으면 지점에서 파생된 이름(branch)만 지운다.
    // 지점 없이 자유 텍스트로 들어온 legacy branch는 보존한다(제목만 고쳐도 지점명이 사라지던 사고 방지).
    const { data: cur } = await supabase.from("jobs").select("branch_id").eq("id", id).maybeSingle();
    if (typeof cur?.branch_id === "number") update.branch = null;
  }
  // ⚠️ branch_id === null(지점 미지정)일 때 client_id를 자동으로 null 하지 않는다.
  // 지점을 비워도 화주사 귀속은 보존한다('화주사만 귀속' 공고가 화주사 필터에서 증발하던 문제).
  // 화주사를 바꾸는 건 셀렉트로 명시 전송한 client_id만으로 한다.

  // 상차지 주소가 바뀌었고 좌표를 함께 안 넘겼으면 지오코딩 (거리 정렬 근거). 주소를 비우면 좌표도 클리어.
  if (typeof update.pickup_address === "string" && update.pickup_address.trim() && update.pickup_lat === undefined) {
    const { geo } = await geocodeAddressWithFallback(update.pickup_address);
    if (geo) {
      update.pickup_lat = geo.lat;
      update.pickup_lng = geo.lng;
    } else {
      // 실패 시 옛 좌표를 남기면 주소는 새 곳, 좌표는 옛 곳 — 반경 규칙·거리 정렬·안내 대상이
      // 전부 예전 집결지를 겨냥한다(가드도 '좌표 있음'으로 통과). 좌표를 비워 사실을 맞춘다.
      update.pickup_lat = null;
      update.pickup_lng = null;
    }
  } else if (update.pickup_address === null || update.pickup_address === "") {
    update.pickup_lat = null;
    update.pickup_lng = null;
  }

  // 마지막 경유지(배송 종료 지점) 주소도 상차지와 동일 패턴 — 변경 시 지오코딩, 비우면 좌표 클리어. 거리 정렬은 둘 중 가까운 쪽 기준.
  if (typeof update.dropoff_address === "string" && update.dropoff_address.trim() && update.dropoff_lat === undefined) {
    const { geo } = await geocodeAddressWithFallback(update.dropoff_address);
    if (geo) {
      update.dropoff_lat = geo.lat;
      update.dropoff_lng = geo.lng;
    } else {
      update.dropoff_lat = null;
      update.dropoff_lng = null;
    }
  } else if (update.dropoff_address === null || update.dropoff_address === "") {
    update.dropoff_lat = null;
    update.dropoff_lng = null;
  }

  // 노출을 좁히는 저장이면, 파이프라인의 '이 명단에게만 노출'과 **같은 공식**으로 먼저 보호한다.
  // 좁히는 경로가 둘(파이프라인 일괄 배정 · 이 수정 모달)인데 여기에만 보호가 없으면
  // 이야기 중인 공고가 지원자 화면에서 사라진다(AI만 그 공고를 말하는 상태). 같은 개념 두 공식 금지.
  // 반경 규칙 쓰기 가드 + 좁힘 감지 — 기준점(집결지 좌표)이 없으면 그 규칙은 **아무도 통과 못 한다**.
  // 노출을 만지지 않고 **집결지 주소만 지우는 저장**에도 걸려야 한다(그때 공고가 조용히 사라진다).
  // 기준(nearest→pickup)·좌표 변경은 반경 규칙 공고에서 노출 축소이기도 하다(실측 296→190) —
  // 아래에서 geoNarrowing으로 M1b 보호(연결 인원 pin)를 함께 돌린다.
  let geoNarrowing = false;
  if (
    "exposure_rule" in update ||
    "pickup_address" in update ||
    "pickup_lat" in update ||
    "dropoff_address" in update ||
    "dropoff_lat" in update ||
    "distance_basis" in update
  ) {
    const { data: geoCur, error: geoErr } = await supabase
      .from("jobs")
      .select(`exposure, exposure_rule, ${EXPOSURE_JOB_GEO_COLUMNS}`)
      .eq("id", id)
      .maybeSingle();
    if (geoErr) {
      console.error("[jobs PATCH] 반경 가드 조회 실패", geoErr);
      return NextResponse.json({ error: "공고 조회 실패 — 아무것도 바꾸지 않았습니다." }, { status: 500 });
    }
    const cur = geoCur as ({ exposure?: string | null; exposure_rule?: unknown } & GeoJob) | null;
    const exposureAfter =
      ("exposure" in update ? (update.exposure as string | null) : cur?.exposure) ?? "all";
    const ruleAfter =
      "exposure_rule" in update ? normalizeRule(update.exposure_rule) : normalizeRule(cur?.exposure_rule);
    // 전체 노출 공고는 규칙이 효력이 없고, 규칙 편집기도 지정 노출에서만 열린다 —
    // 여기서 막으면 반경을 지울 UI가 없는 막다른 길이 된다. 지정 노출일 때만 가드.
    if (exposureAfter === "targeted" && ruleAfter?.radiusKm) {
      const pick = <T,>(k: keyof GeoJob, curVal: T): T =>
        (k in update ? (update[k as string] as T) : curVal);
      const geoAfter: GeoJob = {
        pickup_lat: pick("pickup_lat", cur?.pickup_lat ?? null),
        pickup_lng: pick("pickup_lng", cur?.pickup_lng ?? null),
        dropoff_lat: pick("dropoff_lat", cur?.dropoff_lat ?? null),
        dropoff_lng: pick("dropoff_lng", cur?.dropoff_lng ?? null),
        distance_basis: pick("distance_basis", cur?.distance_basis ?? null),
      };
      if (!jobSupportsRadius(geoAfter)) {
        return NextResponse.json(
          {
            error:
              "이 공고엔 거리 반경 규칙이 걸려 있어 집결지 좌표가 필요해요 — 주소를 지우면 아무에게도 안 보이게 됩니다. 반경 규칙을 먼저 해제하거나 집결지 주소를 남겨 주세요.",
          },
          { status: 400 }
        );
      }
      // 기준점 재료가 하나라도 바뀌면 대상이 줄 수 있다 — 넓어지는 변경까지 포함해 보호를 돌린다
      // (M1b와 같은 판단: 방향 계산의 실패 모드보다 과다 보호가 안전).
      geoNarrowing =
        "pickup_address" in update || "pickup_lat" in update ||
        "dropoff_address" in update || "dropoff_lat" in update ||
        "distance_basis" in update;
    }
  }

  let autoIncluded = 0;
  let narrowingExposure = false;
  if ("exposure" in update || "exposure_rule" in update) {
    const { data: cur, error: curErr } = await supabase
      .from("jobs")
      .select(`exposure, exposure_rule, recruit_mode, ${EXPOSURE_JOB_GEO_COLUMNS}`)
      .eq("id", id)
      .maybeSingle();
    if (curErr) {
      console.error("[jobs PATCH] exposure 현재값 조회 실패", curErr);
      return NextResponse.json({ error: "공고 조회 실패 — 아무것도 바꾸지 않았습니다." }, { status: 500 });
    }
    const curRow = cur as { exposure?: string | null; exposure_rule?: unknown; recruit_mode?: string | null } | null;
    const nextExposure = ("exposure" in update ? (update.exposure as string | null) : curRow?.exposure) ?? "all";
    const nextRule = "exposure_rule" in update ? normalizeRule(update.exposure_rule) : normalizeRule(curRow?.exposure_rule);
    // external(새로 모집)은 맞춤 공고 링크에 애초에 안 뜬다 — 지정 노출로 만들면 명단은 효력이 없고
    // 공개 지원 링크의 후보 연결만 끊긴다. 파이프라인 전환과 같은 규칙을 여기서도 막는다(경로 하나만 닫으면 뚫린다).
    const nextRecruitMode =
      ("recruit_mode" in update ? (update.recruit_mode as string | null) : curRow?.recruit_mode) ?? "external";
    if (nextExposure === "targeted" && nextRecruitMode === "external") {
      return NextResponse.json(
        { error: "'새로 모집' 공고는 지정 노출로 둘 수 없어요 — 맞춤 공고 링크에 뜨지 않는 공고입니다." },
        { status: 400 }
      );
    }
    // 좁아짐 = 결과가 지정 노출이고, (전체→지정 전환이거나 규칙이 바뀜). 규칙이 그대로면 추가 쓰기 없음.
    const narrowing =
      nextExposure === "targeted" &&
      (curRow?.exposure !== "targeted" ||
        JSON.stringify(nextRule) !== JSON.stringify(normalizeRule(curRow?.exposure_rule)));
    narrowingExposure = narrowing;
    if (narrowing) {
      const { inserted, error: protectErr } = await writeExposureProtectRows(supabase, [id]);
      if (protectErr) {
        console.error("[jobs PATCH] exposure protect failed", protectErr);
        return NextResponse.json(
          { error: "이미 연결된 인원을 노출 명단에 남기지 못했어요 — 아무것도 바꾸지 않았습니다." },
          { status: 500 }
        );
      }
      autoIncluded = inserted;
    }
  }

  const { data, error } = await supabase
    .from("jobs")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error || !data) {
    console.error("[jobs PATCH]", error);
    return NextResponse.json({ error: "수정 실패" }, { status: 500 });
  }

  // 기준·좌표 변경만으로도(노출 필드를 안 만져도) 반경 대상이 줄 수 있다 — 같은 보호를 돌린다.
  if (geoNarrowing && !narrowingExposure) {
    const { inserted, error: protectErr } = await writeExposureProtectRows(supabase, [id]);
    if (protectErr) {
      console.error("[jobs PATCH] geo narrowing protect failed", protectErr);
      return NextResponse.json(
        { error: "이미 연결된 인원을 노출 명단에 남기지 못했어요 — 아무것도 바꾸지 않았습니다." },
        { status: 500 }
      );
    }
    autoIncluded += inserted;
    narrowingExposure = true;
  }

  // 보호를 읽은 시점과 저장 사이엔 아직 넓은 노출이라, 그 창에 들어온 관심 클릭은 후보 행만 생기고
  // 명단에는 없다. 저장 뒤 한 번 더 돌려 그 창을 닫는다(저장 후에는 게이트가 fail-closed라 새 행이 안 생긴다).
  // 실패해도 저장은 유지 — 여기서 500을 내면 이미 반영된 수정을 실패로 보고하게 된다(non-fatal).
  if (narrowingExposure) {
    const { inserted: late, error: lateErr } = await writeExposureProtectRows(supabase, [id]);
    if (lateErr) console.error("[jobs PATCH] late exposure protect failed", lateErr);
    else autoIncluded += late;
  }

  return NextResponse.json({ job: data, auto_included: autoIncluded });
}
