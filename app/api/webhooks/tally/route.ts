/**
 * POST /api/webhooks/tally — 홈페이지(Tally 폼) 지원 실시간 인입 어댑터.
 *
 * 배경 (PRODUCT_DIRECTION §6.6 [B]): 기존 homepage 인입은 Tally→Airtable→매시 배치
 * (INSERT-only·무발송·JC 미생성)라 '스크리닝 전' 적체 383명의 원인이었다.
 * 이 어댑터는 Tally 제출을 즉시 /api/apply로 수렴시켜 모든 소스가 동일하게
 * 접수 문자·자동 필터·지오코딩·중복 판정을 타게 한다. airtable-sync는 유실
 * 방지 백필로 유지된다(전화번호 중복이면 skip하므로 이중 등록 없음).
 *
 * 인증: Tally Signing Secret(HMAC-SHA256, base64) — 헤더 `tally-signature`.
 *   env TALLY_SIGNING_SECRET 미설정 시 fail-closed(401). (cron-auth와 동일 방침)
 *
 * 매핑 실패 안전장치: /api/apply 필수 필드가 안 채워지면 리드를 버리지 않고
 * applicants에 직접 INSERT(스크리닝 전, source=homepage) + Slack 경고를 보낸다.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createServiceClient } from "@/lib/supabase";
import { sendSlackText } from "@/lib/slack";

export const dynamic = "force-dynamic";

interface TallyField {
  key: string;
  label: string;
  type: string;
  value: unknown;
  options?: { id: string; text: string }[];
}

/** Tally 필드 값 → 표시 텍스트 (choice류는 option id 배열로 오므로 텍스트로 변환) */
function fieldText(f: TallyField): string {
  const v = f.value;
  if (v == null) return "";
  if (Array.isArray(v)) {
    const byId = new Map((f.options ?? []).map((o) => [o.id, o.text]));
    return v.map((x) => byId.get(String(x)) ?? String(x)).filter(Boolean).join(", ");
  }
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return (f.options ?? []).find((o) => o.id === s)?.text ?? s;
}

/** label 포함 키워드로 필드 찾기 (Tally 질문 문구 = Airtable 컬럼명과 동일) */
function pick(fields: TallyField[], ...keywords: string[]): string {
  for (const kw of keywords) {
    const f = fields.find((x) => x.label?.includes(kw));
    if (f) {
      const t = fieldText(f).trim();
      if (t) return t;
    }
  }
  return "";
}

export async function POST(req: NextRequest) {
  const secret = process.env.TALLY_SIGNING_SECRET;
  const raw = await req.text();

  if (!secret) {
    console.error("[tally webhook] TALLY_SIGNING_SECRET 미설정 — fail-closed");
    return NextResponse.json({ error: "webhook not configured" }, { status: 401 });
  }
  const signature = req.headers.get("tally-signature") ?? "";
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  // 타이밍세이프 비교 — timingSafeEqual은 길이가 다르면 throw하므로 길이 체크 선행
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (!signature || sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: { eventType?: string; data?: { fields?: TallyField[] } };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (payload.eventType && payload.eventType !== "FORM_RESPONSE") {
    return NextResponse.json({ ok: true, skipped: payload.eventType });
  }
  const fields = payload.data?.fields ?? [];
  if (fields.length === 0) {
    return NextResponse.json({ error: "no fields" }, { status: 400 });
  }

  // ── Tally 질문 → /api/apply body 매핑 (질문 문구 기준, lib/airtable.ts F 참조) ──
  const name = pick(fields, "성함");
  const birthDate = (pick(fields, "생년월일").match(/\d{6}/) ?? [""])[0];
  const phone = pick(fields, "연락처").replace(/\D/g, "");
  const sido = pick(fields, "거주지");
  const sigungu = pick(fields, "시/군/구");
  const addrRest = pick(fields, "나머지 주소");
  const location = [sido, sigungu, addrRest].filter(Boolean).join(" ");
  const ownVehicle = pick(fields, "자차");
  const licenseType = pick(fields, "운전면허");
  const vehicleType = pick(fields, "차량 종류");
  const workDays = pick(fields, "요일");
  const workTime = pick(fields, "희망 근로 시간", "근로 시간", "시간대");
  const workHours = [workDays, workTime].filter(Boolean);
  const selfOwnership = pick(fields, "본인 계좌");
  const availableDate = pick(fields, "투입 가능한 날짜", "희망 날짜");
  const career = pick(fields, "경력 사항");
  const similar = pick(fields, "유사한 일");
  const experience = [career, similar].filter(Boolean).join(" / ");

  const applyBody = {
    name,
    birthDate,
    phone,
    location,
    ownVehicle,
    licenseType,
    vehicleType,
    branch1: "미지정", // 홈페이지 폼엔 지점 질문 없음 — 매니저가 지정 (airtable-sync와 동일)
    branch2: null,
    workHours,
    introduction: null,
    experience: experience || null,
    source: "homepage",
    availableDate,
    selfOwnership,
    marketingConsent: false,
  };

  // 1차: 정식 지원 경로로 수렴 (접수 문자·자동 필터·지오코딩·중복 판정 재사용)
  try {
    const res = await fetch(`${req.nextUrl.origin}/api/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(applyBody),
    });
    if (res.ok) {
      return NextResponse.json({ ok: true, via: "apply" });
    }
    const errJson = await res.json().catch(() => null);
    console.error("[tally webhook] /api/apply 거절 — 직접 INSERT 폴백", errJson);
  } catch (e) {
    console.error("[tally webhook] /api/apply 호출 실패 — 직접 INSERT 폴백", e);
  }

  // 2차 폴백: 리드 유실 방지 — 최소 필드로 직접 INSERT + Slack 경고
  if (!phone || !/^\d{10,11}$/.test(phone)) {
    await sendSlackText(
      `⚠️ *Tally 인입 매핑 실패* — 전화번호를 찾지 못해 등록하지 못했어요.\n수신 질문: ${fields.map((f) => f.label).join(" | ").slice(0, 500)}`
    ).catch(() => false);
    return NextResponse.json({ error: "phone 매핑 실패" }, { status: 422 });
  }

  const supabase = createServiceClient();
  const { data: dup } = await supabase
    .from("applicants")
    .select("id")
    .eq("phone", phone)
    .limit(1)
    .maybeSingle();
  if (dup) {
    return NextResponse.json({ ok: true, via: "duplicate-skip" });
  }

  const { error: insErr } = await supabase.from("applicants").insert({
    name: name || "(이름 미상)",
    phone,
    birth_date: birthDate || "",
    location: location || "",
    own_vehicle: ownVehicle || "",
    license_type: licenseType || "",
    vehicle_type: vehicleType || "",
    branch1: "미지정",
    work_hours: workHours.join(", "),
    experience: experience || null,
    self_ownership: selfOwnership || "",
    available_date: availableDate || null,
    status: "스크리닝 전",
    source: "homepage",
    sido: sido || null,
    sigungu: sigungu || null,
  });
  if (insErr) {
    console.error("[tally webhook] 폴백 INSERT 실패", insErr);
    return NextResponse.json({ error: "등록 실패" }, { status: 500 });
  }

  await sendSlackText(
    `⚠️ *Tally 인입 부분 매핑* — ${name || phone}님을 등록했지만 일부 필드가 비었어요(정식 지원 경로 검증 실패). 파이프라인에서 확인해주세요.`
  ).catch(() => false);

  return NextResponse.json({ ok: true, via: "fallback-insert" });
}
