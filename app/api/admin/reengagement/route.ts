/**
 * 재활용(재편입) — GET(미리보기) / POST(편입 실행, 킬스위치 게이팅).
 *
 * GET  : 발굴 결과(활동 후보 이름+전화 · 비활동 집계 · 제외 집계) 반환. 읽기 전용(안전).
 * POST : 활동 후보를 applicants로 편입(import). **킬스위치 ON일 때만** 실제 반입.
 *        OFF면 { enabled:false, imported:0 } 반환(아무 것도 하지 않음).
 * 발송은 하지 않는다 — 편입 후 기존 가드된 발송 플로(블랙리스트·수신거부 하드 가드)로 매니저가 안내.
 * ⚠️ 비지원자 발송의 법적 근거는 실운영 전 검토 필요. 어드민 미들웨어 인증.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  computeReengagementCandidates,
  importActiveCandidates,
  isReengagementEnabled,
  REENGAGEMENT_OFFER_TEMPLATE,
  REENGAGEMENT_OPTIN_TEMPLATE,
} from "@/lib/reengagement";
import { reengagementCandidateKey, selectedReengagementCandidates } from "@/lib/reengagement-selection";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 전화번호 마스킹 — 미리보기엔 비지원자 전화를 노출하지 않는다(전체 전화는 서버 POST에만). */
function maskPhone(p: string): string {
  return p.length >= 7 ? `${p.slice(0, 3)}-****-${p.slice(-4)}` : "****";
}

export async function GET() {
  try {
    const summary = await computeReengagementCandidates();
    // 활동 후보는 이름 + 마스킹 전화만 클라이언트로 — 전체 전화(반입용)는 POST가 서버에서 재계산.
    return NextResponse.json({
      configured: summary.configured,
      enabled: summary.enabled,
      activeCount: summary.activeCount,
      inactiveCount: summary.inactiveCount,
      totalEligible: summary.totalEligible,
      excludedBlacklist: summary.excludedBlacklist,
      excludedApplicants: summary.excludedApplicants,
      activeCandidates: summary.activeCandidates.map((c) => ({
        key: reengagementCandidateKey(c.phone),
        name: c.name,
        phoneMasked: maskPhone(c.phone),
        sources: c.sources,
      })),
      templates: {
        offer: REENGAGEMENT_OFFER_TEMPLATE,
        optin: REENGAGEMENT_OPTIN_TEMPLATE,
      },
    });
  } catch (e) {
    console.error("[reengagement GET] failed", e);
    return NextResponse.json({ error: "재활용 후보 발굴에 실패했어요" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // 킬스위치 하드 게이트 — OFF면 편입(개인정보 반입) 자체를 하지 않는다.
  if (!(await isReengagementEnabled())) {
    return NextResponse.json({
      enabled: false,
      imported: 0,
      note: "‘다시 부르기’가 꺼져 있어요 — 편입 잠금(미리보기만). 설정 › 기능 스위치에서 켤 수 있어요.",
    });
  }
  try {
    const body = await req.json().catch(() => null);
    const candidateKeys = Array.isArray(body?.candidateKeys)
      ? body.candidateKeys.filter((key: unknown): key is string => typeof key === "string")
      : [];
    if (candidateKeys.length === 0) {
      return NextResponse.json({ error: "편입할 후보를 1명 이상 선택해주세요." }, { status: 400 });
    }
    const summary = await computeReengagementCandidates();
    const selected = selectedReengagementCandidates(summary.activeCandidates, candidateKeys);
    if (selected.length === 0) {
      return NextResponse.json({ error: "선택한 후보를 다시 확인해주세요. 발굴 결과가 갱신되었을 수 있어요." }, { status: 409 });
    }
    const imported = await importActiveCandidates(selected);
    return NextResponse.json({
      enabled: true,
      imported,
      requested: selected.length,
      note: `선택한 활동 후보 ${selected.length}명 중 ${imported}명을 인력풀에 편입했습니다. 문자는 발송하지 않았습니다.`,
    });
  } catch (e) {
    console.error("[reengagement POST] failed", e);
    return NextResponse.json({ error: "편입에 실패했어요" }, { status: 500 });
  }
}
