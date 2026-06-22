/**
 * POST /api/admin/backfill-baemin-id
 *
 * baemin_id가 비어 있는 지원자들의 inbound 메시지를 스캔해 배민 커넥트 아이디를 일괄 추출.
 *   1) regex(detectBaeminIdFallback)로 먼저 빠르게 시도 (비용 0)
 *   2) regex가 못 잡으면 Haiku 4.5로 추출 (~₩0.5/건)
 * 추출된 ID는 applicants.baemin_id에 저장 + ai_usage_daily에도 적재.
 *
 * 쿼리:
 *   ?dryRun=true  → DB 수정 없음. 어떤 ID를 채울 예정인지만 보고.
 *   ?dryRun=false → 실제 UPDATE (디폴트).
 *   ?minConfidence=0.7 → Claude conf 임계값 (디폴트 0.7).
 *
 * 응답: { dryRun, examined, results: [...] }
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { detectBaeminIdFallback } from "@/lib/agent/stages/onboarding";
import { extractBaeminIdFromHistory } from "@/lib/agent/baemin-id-extract";
import { recordUsage } from "@/lib/agent/usage";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 21명 × ~2s/건 + 여유

interface PerApplicantResult {
  applicant_id: number;
  name: string | null;
  status: string | null;
  source: "regex" | "claude" | "none";
  baemin_id: string | null;
  confidence: number;
  reasoning: string;
  inbound_count: number;
  updated: boolean;
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "true";
  const minConfidence = Number(url.searchParams.get("minConfidence") ?? "0.7");

  const supabase = createServiceClient();

  // 대상: baemin_id NULL + 활성 상태(부적합/스크리닝 전 제외 — 이쪽엔 ID가 있을 가능성 거의 없음)
  const { data: candidates, error: cErr } = await supabase
    .from("applicants")
    .select("id, name, status, baemin_id")
    .is("baemin_id", null)
    .in("status", ["스크리닝 중", "스크리닝 완료", "확정인력", "대기자"])
    .order("created_at", { ascending: false });

  if (cErr) {
    console.error("[backfill-baemin-id] candidate query failed", cErr);
    return NextResponse.json({ error: cErr.message }, { status: 500 });
  }

  const results: PerApplicantResult[] = [];

  for (const cand of candidates ?? []) {
    const result: PerApplicantResult = {
      applicant_id: cand.id as number,
      name: (cand.name as string | null) ?? null,
      status: (cand.status as string | null) ?? null,
      source: "none",
      baemin_id: null,
      confidence: 0,
      reasoning: "",
      inbound_count: 0,
      updated: false,
    };

    // inbound 메시지 조회 (시간순)
    const { data: msgs } = await supabase
      .from("messages")
      .select("body, created_at")
      .eq("applicant_id", cand.id)
      .eq("direction", "inbound")
      .order("created_at", { ascending: true });

    const bodies = (msgs ?? [])
      .map((m) => String(m.body ?? "").trim())
      .filter(Boolean);
    result.inbound_count = bodies.length;

    if (bodies.length === 0) {
      result.reasoning = "no inbound messages";
      results.push(result);
      continue;
    }

    // 1) regex로 먼저 시도 (각 메시지에 적용)
    let regexHit: string | null = null;
    for (const body of bodies) {
      const id = detectBaeminIdFallback(body);
      if (id) {
        regexHit = id;
        break;
      }
    }

    if (regexHit) {
      result.source = "regex";
      result.baemin_id = regexHit;
      result.confidence = 1; // regex는 결정론적 — confidence 1
      result.reasoning = `regex 추출: '${regexHit}'`;
    } else {
      // 2) regex 실패 → Claude
      const ai = await extractBaeminIdFromHistory({
        inboundMessages: bodies,
        applicantName: result.name,
      });
      if (ai.usage?.model) {
        await recordUsage(supabase, {
          model: ai.usage.model,
          purpose: "triage", // 별도 purpose 없음 — triage로 분류
          usage: ai.usage,
        });
      }
      if (ai.baemin_id && ai.confidence >= minConfidence) {
        result.source = "claude";
        result.baemin_id = ai.baemin_id;
        result.confidence = ai.confidence;
        result.reasoning = `claude 추출 (conf ${ai.confidence.toFixed(2)}): ${ai.reasoning}`;
      } else {
        result.source = "none";
        result.reasoning = ai.baemin_id
          ? `claude conf ${ai.confidence.toFixed(2)} < ${minConfidence} 임계값 미달 — '${ai.baemin_id}' 스킵: ${ai.reasoning}`
          : `claude 추출 실패: ${ai.reasoning}`;
      }
    }

    // 3) UPDATE (dryRun이 아니면)
    if (!dryRun && result.baemin_id) {
      const { error: upErr } = await supabase
        .from("applicants")
        .update({ baemin_id: result.baemin_id })
        .eq("id", cand.id);
      if (upErr) {
        result.reasoning += ` | UPDATE 실패: ${upErr.message}`;
      } else {
        result.updated = true;
      }
    }

    results.push(result);
  }

  // 요약
  const summary = {
    dryRun,
    minConfidence,
    examined: results.length,
    regex_hit: results.filter((r) => r.source === "regex").length,
    claude_hit: results.filter((r) => r.source === "claude").length,
    no_id_found: results.filter((r) => r.source === "none").length,
    updated: results.filter((r) => r.updated).length,
  };

  return NextResponse.json({ ...summary, results });
}
