/**
 * POST /api/admin/jobs/generate-posting
 *
 * 매니저의 거친 채용 메모 → 당근알바 / 알바몬 / 문자(SMS) 3개 채널 형식 공고를 자동 작성.
 * 하이브리드 전략:
 *   1) Claude(generateMultiPlatformPosting) 우선 호출
 *   2) 실패(키 없음/타임아웃/파싱 실패)하면 메모를 휴리스틱 파싱해 목업 템플릿으로 폴백
 * → 시연 중 네트워크/모델 이슈가 있어도 항상 그럴듯한 결과를 반환한다.
 *
 * body: { prompt: string }
 * res:  { ok, source: "ai"|"mock", posting: MultiPlatformPosting }
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { generateMultiPlatformPosting, type MultiPlatformPosting } from "@/lib/claude";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let prompt = "";
  try {
    const body = await req.json();
    prompt = String(body?.prompt ?? "").trim();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!prompt) {
    return NextResponse.json({ error: "채용 조건을 입력해주세요." }, { status: 400 });
  }

  // 1) Claude 우선
  try {
    const ai = await generateMultiPlatformPosting(prompt, createServiceClient());
    if (ai && ai.danggeun?.body && ai.albamon?.body && ai.sms?.body) {
      return NextResponse.json({ ok: true, source: "ai", posting: ai });
    }
  } catch (err) {
    console.error("[generate-posting] claude exception", err);
  }

  // 2) 목업 폴백
  return NextResponse.json({ ok: true, source: "mock", posting: buildMockPosting(prompt) });
}

// ──────────────────────────────────────────────────────────────────────────
// 목업 폴백 — 메모에서 핵심 정보를 휴리스틱으로 뽑아 채널별 템플릿에 채운다.
// ──────────────────────────────────────────────────────────────────────────

function buildMockPosting(prompt: string): MultiPlatformPosting {
  const f = parseRough(prompt);

  const company = f.company || "옹보딩 파트너스";
  const location = f.location || "서울 성동구 성수동";
  const pay = f.pay || "시급 11,000원";
  const schedule = f.schedule || "주 3일 오전 08:00~12:00 (협의 가능)";
  const role = f.role || "매장 청소 및 정리";
  const tags = f.tags.length ? f.tags : ["시니어 우대", "주급 지급", "초보 가능", "4대보험"];

  const title = `[${shortLoc(location)}] ${role} 모집`;

  const danggeun = {
    title: `${shortLoc(location)} ${role} / ${shortSchedule(schedule)} / ${pay}`,
    body: [
      `안녕하세요! ${shortLoc(location)} 동네에서 ${role} 도와주실 이웃 구해요 🙌`,
      ``,
      `⏰ ${schedule}`,
      `💰 ${pay}`,
      `📍 ${location}`,
      ``,
      `60대 이상 시니어 분들 대환영이에요. 처음이셔도 차근차근 알려드려요.`,
      `편하게 채팅 주세요 :)`,
    ].join("\n"),
  };

  const albamon = {
    title: `${company} ${role} 채용 (${shortLoc(location)})`,
    body: [
      `[모집부문]`,
      `- ${role}`,
      ``,
      `[근무조건]`,
      `- 근무시간: ${schedule}`,
      `- 급여: ${pay}`,
      `- 근무지: ${location}`,
      ``,
      `[자격요건]`,
      `- 성실하고 책임감 있으신 분`,
      `- 경력 무관 / 초보 가능`,
      ``,
      `[우대사항]`,
      ...tags.map((t) => `- ${t}`),
    ].join("\n"),
  };

  const sms = {
    title: `${role} 모집 안내`,
    body: [
      `📦 업무: ${role}`,
      `⏰ 시간: ${schedule}`,
      `📍 근무지: ${location}`,
      `💰 급여: ${pay}`,
      ``,
      `🙋 시니어 우대, 초보 가능합니다.`,
      `📩 관심 있으시면 이 문자에 '지원'이라고 답장 주세요.`,
    ].join("\n"),
  };

  return {
    title,
    fields: { company, location, pay, schedule, role, tags },
    danggeun,
    albamon,
    sms,
  };
}

interface ParsedRough {
  company: string;
  location: string;
  pay: string;
  schedule: string;
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

  return { company, location, pay, schedule, role, tags };
}

function shortLoc(loc: string): string {
  const m = loc.match(/([가-힣]+동)|([가-힣]+점)|([가-힣]+구)/);
  return m ? m[0] : loc.split(" ").slice(-1)[0] || loc;
}

function shortSchedule(s: string): string {
  return s.length > 18 ? s.slice(0, 18) + "…" : s;
}
