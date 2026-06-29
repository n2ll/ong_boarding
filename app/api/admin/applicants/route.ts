import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { geocodeAddress } from "@/lib/kakao-geocode";
import { sendSms } from "@/lib/solapi";
import { ensureDanggeunSystemJob } from "@/lib/agent/danggeun-job";
import { ensureBaeminSystemJob } from "@/lib/agent/baemin-job";
import { getSystemMessage, fillTemplate } from "@/lib/agent/system-messages";

export const dynamic = "force-dynamic";

// 매니저가 수기로 INSERT 가능한 컬럼 화이트리스트 (시스템 컬럼 제외)
const CREATE_FIELDS = new Set([
  "name", "phone", "birth_date", "location",
  "own_vehicle", "license_type", "vehicle_type",
  "branch1", "branch2", "branch",
  "work_hours", "available_date", "self_ownership",
  "introduction", "experience",
  "source", "status", "filter_pass", "note", "memo",
  "start_date", "confirmed_slot", "confirmed_branch", "current_branch",
  "churn_reason", "marketing_consent", "kakao_channel_friend",
]);

const VALID_STATUS_SET = new Set(["스크리닝 전", "스크리닝 중", "스크리닝 완료", "기타", "확정인력", "대기자", "부적합", "이탈"]);
const VALID_SLOT_SET = new Set(["평일오전", "평일오후", "주말오전", "주말오후"]);

function validConfirmedSlot(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const tokens = v.split(",").map((t) => t.trim()).filter(Boolean);
  return tokens.every((t) => VALID_SLOT_SET.has(t));
}

// 목록(요약) 응답 컬럼. 무거운 자유텍스트(introduction/screening/note/memo/churn_reason)는
// 목록에서 쓰이지 않으므로 제외해 페이로드를 줄인다. 전체 행은 상세 엔드포인트(/[id])에서 제공.
const LIST_COLUMNS = [
  "id", "created_at", "name", "birth_date", "phone", "location",
  "own_vehicle", "license_type", "vehicle_type",
  "branch1", "branch2", "work_hours", "experience", "available_date", "self_ownership",
  "status", "branch", "source", "filter_pass", "sort_order",
  "last_message_at", "unread_count", "start_date",
  "confirmed_slot", "confirmed_branch", "current_branch", "churned_at",
  "baemin_id", "guide_sent", "onboarding_call_status", "kakao_channel_friend",
  "bname", "sigungu", "sido", "lat", "lng", "geo_precision",
].join(", ");

export async function GET(req: NextRequest) {
  const supabase = createServiceClient();
  const source = new URL(req.url).searchParams.get("source");

  let q = supabase
    .from("applicants")
    .select(LIST_COLUMNS)
    .order("created_at", { ascending: false });

  if (source) q = q.eq("source", source);

  // LIST_COLUMNS는 런타임 문자열이라 select 타입 추론이 안 되므로 결과 타입을 명시한다.
  const { data, error } = await q.returns<({ id: number } & Record<string, unknown>)[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 각 applicant의 latest job_candidates.agent_stage를 함께 내려준다.
  // job_candidates가 없는 후보(예: 당근 수동등록)는 null.
  let withStage = data ?? [];
  if (withStage.length > 0) {
    const ids = withStage.map((a) => a.id);
    const { data: jcs } = await supabase
      .from("job_candidates")
      .select("id, applicant_id, agent_stage, created_at")
      .in("applicant_id", ids)
      .order("created_at", { ascending: false });

    const stageByApplicant = new Map<number, string | null>();
    for (const jc of jcs ?? []) {
      if (!stageByApplicant.has(jc.applicant_id as number)) {
        stageByApplicant.set(jc.applicant_id as number, jc.agent_stage as string | null);
      }
    }
    withStage = withStage.map((a) => ({
      ...a,
      agent_stage: stageByApplicant.get(a.id) ?? null,
    }));
  }

  return NextResponse.json({ data: withStage });
}

/**
 * POST /api/admin/applicants — 매니저 수기 등록.
 * 필수: name, phone, branch1. 그 외는 옵셔널 (어떤 컬럼도 비워둘 수 있음).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    const phone = String(body.phone ?? "").replace(/-/g, "");
    const branch1 = String(body.branch1 ?? "").trim();

    if (!name) return NextResponse.json({ error: "이름은 필수입니다." }, { status: 400 });
    // 매니저 수기 등록은 이름만 필수. phone/branch1는 빈 값 허용 — 추후 미니 상세에서 매니저가 직접 채움.
    // 단, phone이 입력됐으면 형식 검증.
    if (phone && !/^\d{10,11}$/.test(phone)) {
      return NextResponse.json({ error: "전화번호 형식이 올바르지 않습니다." }, { status: 400 });
    }

    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!CREATE_FIELDS.has(k)) continue;
      row[k] = v === "" ? null : v;
    }
    if (row.status && !VALID_STATUS_SET.has(row.status as string)) {
      return NextResponse.json({ error: `invalid status: ${row.status}` }, { status: 400 });
    }
    if (row.confirmed_slot && !validConfirmedSlot(row.confirmed_slot)) {
      return NextResponse.json({ error: "invalid confirmed_slot" }, { status: 400 });
    }

    // 기본값 보강 — 빈 값은 null로 정규화 (이름만 필수)
    row.name = name;
    row.phone = phone || null;
    row.branch1 = branch1 || null;
    row.branch = row.branch ?? (branch1 || null);
    row.source = row.source ?? "manual";
    // 기본 상태: 당근·배민(자동 AI 응대) → '스크리닝 중', 그 외 → '스크리닝 전'
    if (!row.status) {
      row.status = (row.source === "danggeun" || row.source === "danggeun_practice" || row.source === "baemin")
        ? "스크리닝 중"
        : "스크리닝 전";
    }
    if (row.marketing_consent === true) {
      row.marketing_consent_at = new Date().toISOString();
    }

    // 주소 지오코딩 (실패해도 INSERT 진행)
    const location = (row.location as string | null) ?? null;
    if (location && location.trim()) {
      try {
        const geo = await geocodeAddress(location);
        if (geo) {
          row.lat = geo.lat;
          row.lng = geo.lng;
          row.sido = geo.sido;
          row.sigungu = geo.sigungu;
          row.bname = geo.bname;
          row.road_address = geo.road_address;
        }
      } catch (e) {
        console.warn("[applicants POST] geocode skipped", e);
      }
    }

    const supabase = createServiceClient();
    const { data, error } = await supabase.from("applicants").insert(row).select().single();
    if (error) {
      console.error("[applicants POST] insert error", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 자동 흐름 트리거:
    //   - 당근/연습용 당근: 시작 멘트 SMS 발송 + job_candidates 생성 (당근은 매니저가 먼저 보냄)
    //   - 배민: 시작 멘트 SMS 발송 X (지원자가 먼저 보냄) + job_candidates만 생성
    //   - 기타 source(manual/facebook/naver/direct): 자동 흐름 없음
    const source = data.source as string | null;
    const isDanggeun = source === "danggeun" || source === "danggeun_practice";
    const isBaemin = source === "baemin";
    const isWeekendSlot = String(data.work_hours ?? "").includes("주말");
    const screeningAutoTrue: Record<string, boolean> = {
      프로모션_종료가능성_안내: true,
      정산주기_안내: true,
      업무시간_체계_이해: true,
      ...(isWeekendSlot ? {} : { 공휴일_업무여부_확인: true }),
    };

    if (isDanggeun && data.status === "스크리닝 중") {
      try {
        const startMsg = (await getSystemMessage(supabase, "danggeun_start"))?.trim();
        if (startMsg) {
          const filled = fillTemplate(startMsg, {
            이름: data.name ?? "",
            지점: data.branch ?? data.branch1 ?? "",
            시간대: shortWorkHours(data.work_hours ?? null),
          });
          let messageId: string | null = null;
          if (source === "danggeun") {
            const r = await sendSms(data.phone, filled);
            if (!r.success) {
              console.error("[applicants POST] danggeun start SMS fail", r.error);
            }
            messageId = r.messageId ?? null;
          }

          let jobIdForMsg: number | null = null;
          try {
            const jobId = await ensureDanggeunSystemJob(supabase);
            jobIdForMsg = jobId;
            await supabase.from("job_candidates").insert({
              job_id: jobId,
              applicant_id: data.id,
              agent_stage: "screening",
              agent_state: {
                screening: screeningAutoTrue,
                meta: { screening_entered_at: new Date().toISOString() },
              },
            });
          } catch (e) {
            console.error("[applicants POST] danggeun system job ensure failed", e);
          }

          await supabase.from("messages").insert({
            applicant_id: data.id,
            applicant_phone: data.phone,
            direction: "outbound",
            body: filled,
            status: source === "danggeun" ? "sent" : "simulated",
            sent_by: source === "danggeun" ? "danggeun-start" : "danggeun-practice-start",
            solapi_msg_id: messageId,
            message_type: "sms",
            job_id: jobIdForMsg,
          });
        } else {
          console.warn("[applicants POST] danggeun_start system message empty — auto flow skipped");
        }
      } catch (e) {
        console.error("[applicants POST] danggeun auto flow failed", e);
      }
    }

    if (isBaemin && data.status === "스크리닝 중") {
      // 배민은 지원자가 먼저 보낸 흐름이라 시작 멘트 발송 없음 — job_candidates만 생성해
      // 인입 라우터가 다음 답장부터 스크리닝 stage로 처리할 수 있게 한다.
      try {
        const jobId = await ensureBaeminSystemJob(supabase);
        await supabase.from("job_candidates").insert({
          job_id: jobId,
          applicant_id: data.id,
          agent_stage: "screening",
          agent_state: {
            screening: screeningAutoTrue,
            meta: { screening_entered_at: new Date().toISOString() },
          },
        });
      } catch (e) {
        console.error("[applicants POST] baemin auto flow failed", e);
      }
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[applicants POST] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

// 희망 시간대 축약 — "평일오전, 주말오후" 등을 그대로 사용. 빈 값 대비.
function shortWorkHours(wh: string | null): string {
  if (!wh || wh === "미확인") return "";
  return wh
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
}
