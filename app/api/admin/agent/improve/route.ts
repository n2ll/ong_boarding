/**
 * POST /api/admin/agent/improve — 에이전트 재귀개선 v1 (R4-1)
 *
 * 최근 7일 재료(각 최대 20건)에서 AI가 배울 거리를 뽑아 지식/예시 개선안을 제안한다.
 *  ① message_drafts status='edited' — AI 초안 vs 매니저 수정본 페어 (+ inbound 원문)
 *  ② paused 인계 사유 — paused_reason + agent_state.meta.pause.summary
 *     ('에이전트 호출 실패%'는 기술 이슈라 제외)
 *  ③ message_drafts status='need_info' — missing_info
 *
 * 반영은 반드시 매니저 승인(두뇌 탭 개선 제안 UI) — 이 라우트는 저장하지 않고
 * 제안 배열만 즉석 반환한다(v1). Claude 호출은 Sonnet 4.6, ai_usage_daily purpose='improve' 적재.
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { recordUsage } from "@/lib/agent/usage";

export const dynamic = "force-dynamic";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const TECH_FAILURE_PREFIX = "에이전트 호출 실패";

interface ImproveProposal {
  kind: "knowledge" | "conversation_example" | "system_message_tweak";
  title: string;
  body: string;
  evidence: string;
  confidence: "high" | "medium";
}

interface EditedDraftRow {
  id: number;
  draft_text: string | null;
  inbound_message_id: number | null;
  used_message_id: number | null;
}

interface PausedRow {
  paused_reason: string | null;
  agent_state: { meta?: { pause?: { category?: string | null; summary?: string | null } } } | null;
}

interface NeedInfoRow {
  missing_info: string | null;
}

interface KbRow {
  category: string;
  title: string;
  body: string;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const IMPROVE_SYSTEM_PROMPT = `너는 시니어 긱워커 채용 플랫폼 '옹보딩'의 AI 응대 에이전트(옹봇)를 개선하는 코치다.
매니저가 AI 초안을 고쳐 보낸 사례, 매니저 인계 사유, AI가 정보 부족으로 멈춘 사례를 보고,
지식베이스에 추가하면 다음부터 AI가 더 잘 응대할 수 있는 개선안을 뽑아라.

규칙:
- 반드시 propose_improvements 도구로만 응답해라.
- kind 구분: 'knowledge' = 일반 라인 FAQ에 추가할 공식 답변(정산·유류비·보험 등 사실 답변), 'conversation_example' = 말투·응대 방식을 잡아줄 대화 예시, 'system_message_tweak' = 자동 발송 문구 수정 제안.
- body는 지식베이스에 그대로 넣을 수 있는 완성된 텍스트로 써라. 실무자(채용 매니저)가 쓰는 쉬운 한국어. "~하면 좋겠다" 같은 메타 설명 금지.
- 절대 규칙(확정 뉘앙스 금지): 지원자가 정보를 보내거나 긍정해도 근무 확정/배정이 아니다. 확정은 매니저가 한다. body에 "확정되셨습니다", "배정됐습니다", "합격입니다" 같은 확정 뉘앙스를 절대 넣지 마라.
- 아래 [기존 지식베이스]에 이미 있는 내용과 중복되는 제안은 만들지 마라.
- evidence는 어떤 재료(몇 번째 사례)에서 배웠는지 근거 1줄.
- 확신 있는 것만, 최대 5개. 재료가 부실하거나 배울 게 없으면 proposals를 빈 배열로 반환해라.`;

export async function POST() {
  try {
    const apiKey = process.env.CLAUDE_API;
    if (!apiKey) {
      console.error("[agent/improve] CLAUDE_API env missing");
      return NextResponse.json({ error: "CLAUDE_API 미설정" }, { status: 500 });
    }

    const supabase = createServiceClient();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // ── 재료 ① AI 초안 vs 매니저 수정본 (draft_was_edited=true로 발송 → status='edited')
    const { data: editedData, error: editedErr } = await supabase
      .from("message_drafts")
      .select("id, draft_text, inbound_message_id, used_message_id")
      .eq("status", "edited")
      .not("used_message_id", "is", null)
      .gte("resolved_at", since)
      .order("resolved_at", { ascending: false })
      .limit(20);
    if (editedErr) console.error("[agent/improve] edited drafts fetch", editedErr);
    const editedDrafts = (editedData ?? []) as EditedDraftRow[];

    const msgIds = new Set<number>();
    for (const d of editedDrafts) {
      if (d.inbound_message_id) msgIds.add(d.inbound_message_id);
      if (d.used_message_id) msgIds.add(d.used_message_id);
    }
    const msgBody = new Map<number, string>();
    if (msgIds.size > 0) {
      const { data: msgs } = await supabase
        .from("messages")
        .select("id, body")
        .in("id", Array.from(msgIds));
      for (const m of (msgs ?? []) as { id: number; body: string | null }[]) {
        if (m.body) msgBody.set(m.id, m.body);
      }
    }
    const editedPairs = editedDrafts
      .map((d) => ({
        inbound: d.inbound_message_id ? msgBody.get(d.inbound_message_id) ?? null : null,
        ai_draft: d.draft_text,
        manager_final: d.used_message_id ? msgBody.get(d.used_message_id) ?? null : null,
      }))
      .filter((p) => p.ai_draft && p.manager_final && p.ai_draft !== p.manager_final);

    // ── 재료 ② paused 인계 사유 (기술 이슈 '에이전트 호출 실패%' 제외)
    const { data: pausedData, error: pausedErr } = await supabase
      .from("job_candidates")
      .select("paused_reason, agent_state")
      .eq("agent_stage", "paused")
      .gte("updated_at", since)
      .order("updated_at", { ascending: false })
      .limit(40);
    if (pausedErr) console.error("[agent/improve] paused fetch", pausedErr);
    const handoffs = ((pausedData ?? []) as PausedRow[])
      .filter((r) => !(r.paused_reason ?? "").startsWith(TECH_FAILURE_PREFIX))
      .slice(0, 20)
      .map((r) => {
        const pause = r.agent_state?.meta?.pause;
        return {
          reason: r.paused_reason ?? null,
          category: pause?.category ?? null,
          summary: pause?.summary ?? null,
        };
      })
      .filter((h) => h.reason || h.summary);

    // ── 재료 ③ need_info 초안의 missing_info
    const { data: needInfoData, error: needInfoErr } = await supabase
      .from("message_drafts")
      .select("missing_info")
      .eq("status", "need_info")
      .gte("created_at", since)
      .not("missing_info", "is", null)
      .order("created_at", { ascending: false })
      .limit(20);
    if (needInfoErr) console.error("[agent/improve] need_info fetch", needInfoErr);
    const missingInfos = ((needInfoData ?? []) as NeedInfoRow[])
      .map((r) => (r.missing_info ?? "").trim())
      .filter(Boolean);

    // 재료가 전혀 없으면 Claude 호출 없이 빈 제안 반환 (비용 0)
    if (editedPairs.length === 0 && handoffs.length === 0 && missingInfos.length === 0) {
      return NextResponse.json({ proposals: [] });
    }

    // ── 기존 지식 rows — 중복 제안 방지용 컨텍스트
    const { data: kbData } = await supabase
      .from("prompt_examples")
      .select("category, title, body")
      .in("category", ["knowledge", "conversation"])
      .order("sort_order", { ascending: true });
    const kbRows = ((kbData ?? []) as KbRow[]).filter((k) => !k.title.startsWith("__"));

    const kbSection =
      kbRows.length > 0
        ? kbRows.map((k) => `- [${k.category}] ${k.title}: ${clip(k.body, 120)}`).join("\n")
        : "(비어 있음)";
    const editedSection =
      editedPairs.length > 0
        ? editedPairs
            .map(
              (p, i) =>
                `${i + 1}) 지원자 문의: ${clip(p.inbound ?? "(원문 없음)", 300)}\n   AI 초안: ${clip(p.ai_draft ?? "", 300)}\n   매니저 수정본(실제 발송): ${clip(p.manager_final ?? "", 300)}`
            )
            .join("\n")
        : "(없음)";
    const handoffSection =
      handoffs.length > 0
        ? handoffs
            .map(
              (h, i) =>
                `${i + 1}) 사유: ${clip(h.reason ?? h.summary ?? "", 200)}${h.category ? ` (분류: ${h.category})` : ""}${h.summary && h.summary !== h.reason ? `\n   요약: ${clip(h.summary, 200)}` : ""}`
            )
            .join("\n")
        : "(없음)";
    const missingSection =
      missingInfos.length > 0
        ? missingInfos.map((m, i) => `${i + 1}) ${clip(m, 200)}`).join("\n")
        : "(없음)";

    const userContent = `[기존 지식베이스 — 이 내용과 중복되는 제안 금지]
${kbSection}

[재료 A — 매니저가 AI 초안을 고쳐서 보낸 사례 (최근 7일, ${editedPairs.length}건)]
${editedSection}

[재료 B — 매니저 인계(pause) 사유 (최근 7일, ${handoffs.length}건)]
${handoffSection}

[재료 C — AI가 정보 부족(need_info)으로 멈춘 사례의 부족 정보 (최근 7일, ${missingInfos.length}건)]
${missingSection}

위 재료에서 배울 수 있는 지식/예시 개선안을 propose_improvements 도구로 제안해라.`;

    const body = {
      model: MODEL,
      max_tokens: 3072,
      system: IMPROVE_SYSTEM_PROMPT,
      tools: [
        {
          name: "propose_improvements",
          description: "재료에서 배운 지식베이스 개선 제안 배열을 반환합니다. 배울 게 없으면 빈 배열.",
          input_schema: {
            type: "object",
            properties: {
              proposals: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["knowledge", "conversation_example", "system_message_tweak"],
                      description:
                        "knowledge=일반 라인 FAQ 공식 답변, conversation_example=대화 예시, system_message_tweak=자동 발송 문구 수정 제안",
                    },
                    title: { type: "string", description: "지식 항목 제목 (짧게, 예: '유류비 지원 여부')" },
                    body: {
                      type: "string",
                      description: "지식베이스에 그대로 넣을 완성 텍스트. 확정 뉘앙스 절대 금지.",
                    },
                    evidence: { type: "string", description: "어떤 재료에서 배웠는지 근거 1줄" },
                    confidence: { type: "string", enum: ["high", "medium"] },
                  },
                  required: ["kind", "title", "body", "evidence", "confidence"],
                },
              },
            },
            required: ["proposals"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "propose_improvements" },
      messages: [{ role: "user", content: userContent }],
    };

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[agent/improve] Claude HTTP", res.status, await res.text());
      return NextResponse.json({ error: "Claude 호출 실패" }, { status: 502 });
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; name?: string; input?: { proposals?: unknown } }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    };

    await recordUsage(supabase, { model: MODEL, purpose: "improve", usage: data.usage });

    const block = data.content?.find((c) => c.type === "tool_use");
    const rawInput = block?.input?.proposals;
    const raw: unknown[] = Array.isArray(rawInput) ? rawInput : [];
    const KINDS = new Set(["knowledge", "conversation_example", "system_message_tweak"]);
    const proposals: ImproveProposal[] = raw
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
      .filter(
        (p) =>
          typeof p.kind === "string" &&
          KINDS.has(p.kind) &&
          typeof p.title === "string" &&
          p.title.trim() !== "" &&
          typeof p.body === "string" &&
          p.body.trim() !== ""
      )
      .slice(0, 5)
      .map((p) => ({
        kind: p.kind as ImproveProposal["kind"],
        title: (p.title as string).trim(),
        body: (p.body as string).trim(),
        evidence: typeof p.evidence === "string" ? p.evidence.trim() : "",
        confidence: p.confidence === "high" ? "high" : "medium",
      }));

    return NextResponse.json({ proposals });
  } catch (err) {
    console.error("[agent/improve] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
