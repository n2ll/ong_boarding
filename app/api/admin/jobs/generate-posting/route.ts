/**
 * POST /api/admin/jobs/generate-posting
 *
 * 매니저의 거친 채용 메모 → 구인광고 원문 / 지원자 안내 문자 형식으로 자동 작성.
 * 하이브리드 전략:
 *   1) Claude(generateMultiPlatformPosting) 우선 호출
 *   2) 실패(키 없음/타임아웃/파싱 실패)하면 메모를 휴리스틱 파싱해 목업 템플릿으로 폴백
 * → 시연 중 네트워크/모델 이슈가 있어도 항상 그럴듯한 결과를 반환한다.
 *
 * body: { prompt: string, client_id?, branch_id?, pickup_address?, dropoff_address? }
 * res:  { ok, source: "ai"|"mock", posting: MultiPlatformPosting }
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { generateMultiPlatformPosting, type MultiPlatformPosting } from "@/lib/claude";
import {
  buildCurrentJobPostingLocationContext,
  formatCurrentJobPostingLocation,
} from "@/lib/admin/job-posting-context";
import { resolveJobAnnouncementBody } from "@/lib/admin/job-announcement-copy";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let prompt = "";
  let clientId: number | null = null;
  let branchId: number | null = null;
  let pickupAddress = "";
  let dropoffAddress = "";
  try {
    const body = await req.json();
    prompt = String(body?.prompt ?? "").trim();
    if (typeof body?.client_id === "number") clientId = body.client_id;
    if (typeof body?.branch_id === "number") branchId = body.branch_id;
    if (typeof body?.pickup_address === "string") pickupAddress = body.pickup_address.trim();
    if (typeof body?.dropoff_address === "string") dropoffAddress = body.dropoff_address.trim();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!prompt) {
    return NextResponse.json({ error: "채용 조건을 입력해주세요." }, { status: 400 });
  }

  const supabase = createServiceClient();
  // 선택된 화주사·지점 마스터에서 검증된 사실(화주사명·지점 집결지/시급 등 ai_facts)을 모아 초안 생성에 주입(D2).
  const masterContext = await buildMasterContext(supabase, clientId, branchId);
  // 상차지·배송지는 라인 마스터가 아니라 이번 공고의 값이 권위값이다. 마스터와 충돌하면 이 값을 우선하라고 명시한다.
  const currentLocation = { pickupAddress, dropoffAddress };
  const currentLocationContext = buildCurrentJobPostingLocationContext(currentLocation);
  const generationContext = [masterContext, currentLocationContext].filter(Boolean).join("\n") || undefined;

  // 1) Claude 우선
  try {
    const ai = await generateMultiPlatformPosting(prompt, supabase, generationContext);
    if (ai && ai.albamon?.body && ai.sms?.body) {
      return NextResponse.json({
        ok: true,
        source: "ai",
        posting: {
          ...ai,
          sms: {
            ...ai.sms,
            body: resolveJobAnnouncementBody({ jobTitle: ai.title, smsDraft: ai.sms.body }),
          },
        },
      });
    }
  } catch (err) {
    console.error("[generate-posting] claude exception", err);
  }

  // 2) 목업 폴백
  return NextResponse.json({
    ok: true,
    source: "mock",
    posting: buildMockPosting(prompt, formatCurrentJobPostingLocation(currentLocation)),
  });
}

// 화주사(clients.name) + 지점(branches.name·ai_facts)에서 '검증된 사실'을 조립. 없으면 undefined.
async function buildMasterContext(
  supabase: ReturnType<typeof createServiceClient>,
  clientId: number | null,
  branchId: number | null
): Promise<string | undefined> {
  const facts: string[] = [];
  try {
    if (clientId != null) {
      const { data } = await supabase.from("clients").select("name").eq("id", clientId).maybeSingle();
      if (data?.name) facts.push(`화주사(고객사): ${data.name}`);
    }
    if (branchId != null) {
      const { data } = await supabase.from("branches").select("name, ai_facts").eq("id", branchId).maybeSingle();
      if (data?.name) facts.push(`지점: ${data.name}`);
      const aiFacts = data?.ai_facts ? String(data.ai_facts).trim() : "";
      if (aiFacts) facts.push(`지점 상세(집결지·시급·특이사항): ${aiFacts}`);
    }
  } catch (e) {
    console.error("[generate-posting] master context lookup failed", e);
  }
  return facts.length ? facts.join("\n") : undefined;
}

// ──────────────────────────────────────────────────────────────────────────
// 목업 폴백 — 메모에서 핵심 정보를 휴리스틱으로 뽑아 채널별 템플릿에 채운다.
// ──────────────────────────────────────────────────────────────────────────

function buildMockPosting(prompt: string, currentLocation = ""): MultiPlatformPosting {
  const f = parseRough(prompt);

  const company = f.company;
  const location = currentLocation || f.location || "";
  const pay = f.pay;
  const schedule = f.schedule;
  const role = f.role || "업무";
  const tags = f.tags;

  const shortLocation = shortLoc(location);
  const title = `${shortLocation ? `[${shortLocation}] ` : ""}${role} 모집`;

  const workConditionLines = [
    schedule ? `- 근무시간: ${schedule}` : null,
    pay ? `- 급여: ${pay}` : null,
    location ? `- 근무지: ${location}` : null,
  ].filter((line): line is string => Boolean(line));

  const albamon = {
    title: [company, role, "모집", shortLocation ? `(${shortLocation})` : null].filter(Boolean).join(" "),
    body: [
      `[모집부문]`,
      `- ${role}`,
      ``,
      `[근무조건]`,
      ...(workConditionLines.length ? workConditionLines : [`- 입력된 근무조건을 확인해 주세요`]),
      ``,
      `[자격요건]`,
      `- 입력된 자격요건을 확인해 주세요`,
      ``,
      `[우대사항]`,
      ...(tags.length ? tags.map((t) => `- ${t}`) : [`- 입력된 우대조건 없음`]),
    ].join("\n"),
  };

  const sms = {
    title: `${role} 모집 안내`,
    body: resolveJobAnnouncementBody({ jobTitle: title }),
  };

  return {
    title,
    fields: {
      company,
      location,
      pickupAddress: f.pickupAddress,
      dropoffAddress: f.dropoffAddress,
      pay,
      schedule,
      capacity: f.capacity,
      vehicleRequired: f.vehicleRequired,
      workPeriod: f.workPeriod,
      slotKeys: f.slotKeys,
      role,
      tags,
    },
    albamon,
    sms,
  };
}

interface ParsedRough {
  company: string;
  location: string;
  pickupAddress: string;
  dropoffAddress: string;
  pay: string;
  schedule: string;
  capacity: number | null;
  vehicleRequired: boolean | null;
  workPeriod: "" | "하루" | "단기" | "정기";
  slotKeys: ("평일오전" | "평일오후" | "주말오전" | "주말오후")[];
  role: string;
  tags: string[];
}

function parseRough(text: string): ParsedRough {
  const t = text.replace(/\s+/g, " ").trim();

  // 급여: "시급 1.1만", "시급 11000원", "일급 9만", "월 250" 등
  let pay = "";
  const payUnit = t.match(/(시급|일급|주급|월급|월)\s*([\d.,]+)\s*(만원|만|원)?/);
  if (payUnit) {
    const unit = payUnit[1] === "월" ? "월급" : payUnit[1];
    let num = parseFloat(payUnit[2].replace(/,/g, ""));
    const scale = payUnit[3];
    if (scale === "만원" || scale === "만") num = num * 10000;
    pay = `${unit} ${Math.round(num).toLocaleString()}원`;
  }

  // 위치: "OO구 OO동", "OO점", "OO동"
  let location = "";
  const locMatch =
    t.match(/([가-힣]+(?:시|도))?\s*([가-힣]+구)\s*([가-힣]+동)/) ||
    t.match(/([가-힣]+구)\s*([가-힣]+동)/) ||
    t.match(/([가-힣]{2,}점)/) ||
    t.match(/([가-힣]{2,}동)\b/);
  if (locMatch) location = locMatch[0].trim();

  const labeledValue = (labels: string) => {
    const match = text.match(new RegExp(`(?:${labels})\\s*[:：]?\\s*([^\\n,;]+)`, "i"));
    return match?.[1]?.trim() ?? "";
  };
  const pickupAddress = labeledValue("상차지|집결지|출발지");
  const dropoffAddress = labeledValue("배송\\s*권역|배송지|도착지|종료\\s*지점|마지막\\s*경유지");

  // 회사/매장: "스타벅스 성수점", "비마트 강남점" 같이 'XX점' 앞 단어
  let company = "";
  const compMatch = t.match(/([가-힣A-Za-z]+)\s*([가-힣]+점)/);
  if (compMatch) company = `${compMatch[1]} ${compMatch[2]}`;

  // 스케줄: "주 3일", "오전", "오후", "08:00~12:00", "월수금"
  const schedParts: string[] = [];
  const days = t.match(/주\s*\d일/);
  if (days) schedParts.push(days[0].replace(/\s+/g, " "));
  const dow = t.match(/(월|화|수|목|금|토|일)(?:[,/]?\s*(월|화|수|목|금|토|일))+/);
  if (dow) schedParts.push(dow[0]);
  if (/오전/.test(t)) schedParts.push("오전");
  if (/오후/.test(t)) schedParts.push("오후");
  if (/주말/.test(t)) schedParts.push("주말");
  const timeRange = t.match(/\d{1,2}\s*[:시]\s*\d{0,2}\s*[~-]\s*\d{1,2}\s*[:시]\s*\d{0,2}/);
  if (timeRange) schedParts.push(timeRange[0].replace(/\s+/g, ""));
  const schedule = schedParts.join(" ");
  const capacityMatch = t.match(/(?:모집\s*)?(\d+)\s*명/);
  const capacity = capacityMatch ? Number(capacityMatch[1]) : null;
  const vehicleRequired = /차량\s*(?:불필요|없어도|없이)|도보\s*가능/.test(t)
    ? false
    : /(?:자차|차량|오토바이|이륜차|승용차|승합차|\d+톤)\s*(?:필수|필요|지참)/.test(t)
      ? true
      : null;
  const workPeriod: ParsedRough["workPeriod"] = /당일|하루/.test(t)
    ? "하루"
    : /상시|정기|장기/.test(t)
      ? "정기"
      : /단기|며칠|몇\s*주/.test(t)
        ? "단기"
        : "";
  const weekday = /평일|월|화|수|목|금/.test(t);
  const weekend = /주말|토|일/.test(t);
  const morning = /오전|새벽/.test(t);
  const afternoon = /오후|저녁|야간/.test(t);
  const slotKeys: ParsedRough["slotKeys"] = [];
  if (weekday && morning) slotKeys.push("평일오전");
  if (weekday && afternoon) slotKeys.push("평일오후");
  if (weekend && morning) slotKeys.push("주말오전");
  if (weekend && afternoon) slotKeys.push("주말오후");

  // 직무: "청소", "배달", "배송", "정리", "관리", "주방", "서빙" 등 키워드
  let role = "";
  const roleKw = t.match(/(청소|배달|배송|정리|관리|주방|서빙|포장|상하차|운반|안내|매장)\S*/g);
  if (roleKw) role = roleKw.slice(0, 2).join(" ");

  // 태그: 시니어/우대/4대보험/주급/초보 등 자주 등장 키워드 추출
  const tags: string[] = [];
  if (/시니어|6\d대|7\d대|고령|어르신/.test(t)) tags.push("시니어 우대");
  if (/주급/.test(t)) tags.push("주급 지급");
  if (/4대보험|사대보험/.test(t)) tags.push("4대보험");
  if (/초보|미경험|경력무관/.test(t)) tags.push("초보 가능");
  if (/식사|중식|식대/.test(t)) tags.push("식사 제공");
  if (/주차/.test(t)) tags.push("주차 가능");

  return {
    company,
    location,
    pickupAddress,
    dropoffAddress,
    pay,
    schedule,
    capacity,
    vehicleRequired,
    workPeriod,
    slotKeys,
    role,
    tags,
  };
}

function shortLoc(loc: string): string {
  const m = loc.match(/([가-힣]+동)|([가-힣]+점)|([가-힣]+구)/);
  return m ? m[0] : loc.split(" ").slice(-1)[0] || loc;
}

function shortSchedule(s: string): string {
  return s.length > 18 ? s.slice(0, 18) + "…" : s;
}
