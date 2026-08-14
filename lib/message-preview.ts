import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 대화 미리보기 — 지원자별 '마지막 메시지 한 줄' + 판정 신호.
 *
 * 원래 /api/admin/messages/preview 라우트 안에만 있었는데, 실시간 응대 목록이
 * 이 값에 **누가 목록에 뜨는지**를 의존하기 때문에 목록 응답에도 함께 실어야 한다
 * (그래서 공용 모듈로 뽑았다 — 두 곳이 같은 판정을 쓰지 않으면 목록과 배지가 어긋난다).
 *
 * 왜 목록 응답에 실어야 하는가:
 *   예전에는 (1) 목록을 받고 → (2) 그 안의 id로 미리보기를 다시 물었다. 그런데 목록
 *   통과 조건이 (2)의 결과에 걸려 있다(최근 답장한 풀 응답자 · 매니저가 보내고 회신을
 *   기다리는 대화). 그래서 화면에 처음 뜨는 명단과 1초 뒤 명단이 **서로 달랐다** —
 *   사람이 나타나고 사라지고, 미리보기 줄과 배지가 뒤늦게 붙었다.
 *   느린 게 아니라 두 번 그려지는 것이었다.
 */

/**
 * AI·시스템 자동 발송 라벨 — 이 외 outbound는 '매니저 수동 발신'으로 본다
 * (send/route.ts의 pause 판정, handoffs/promote의 수동 답변 판정과 동일한 deny-list 관례).
 * system-bulk(캠페인 벌크 핑)를 자동으로 분류해, 벌크 발송 대상 전원이 '답 대기'로 뜨지 않게 한다.
 */
export const AUTO_SENT_BY = new Set([
  "agent",
  "agent-practice",
  "system-auto",
  "system-bulk",
  "system-reminder",
  "system-onboarding-reminder",
  "system-first-day",
  "system-venue-guide",
  "system-baemin-invite",
  "danggeun-start",
  "baemin-start",
  "danggeun-practice-start",
  "danggeun-recommend",
  "dispatch",
  "multijob-test",
]);

/** '답 대기' 후보로 볼 최근 수동 발신 기간. LiveConsole의 RECENT_INBOUND_MS와 같은 값이어야 한다. */
export const RECENT_MANUAL_MS = 14 * 24 * 60 * 60 * 1000;

export interface LastMessagePreview {
  body: string;
  direction: string;
  created_at: string;
  sent_by: string | null;
  /** 마지막 메시지가 '매니저 수동 발신'인가 — 클라이언트 '답 대기' 판정용 */
  manual_outbound: boolean;
  last_inbound_at: string | null;
  /** 미처리 AI 초안(pending/need_info) 보유 — 목록 '초안 대기' 배지용 */
  pending_draft: boolean;
}

export type PreviewMap = Record<number, LastMessagePreview>;

/**
 * @param ids          미리보기를 뽑을 지원자. withManual이 켜지면 여기에 합집합이 더해진다.
 * @param withManual   최근 14일 내 매니저 수동 발신이 있는 지원자를 서버가 찾아 ids에 합친다.
 *                     applicants.last_message_at은 inbound 수신 시각이라, 발신만 있는 대화
 *                     (답 대기)는 클라이언트가 스스로 찾을 수 없다.
 */
export async function gatherMessagePreviews(
  supabase: SupabaseClient,
  ids: number[],
  opts: { withManual?: boolean } = {},
): Promise<PreviewMap> {
  const allIds = new Set<number>(ids.filter((n) => Number.isFinite(n)));

  if (opts.withManual) {
    // 최근 14일 outbound 전량 스캔 — 캠페인 벌크 발송 한 번이면 수천 행이 된다.
    // limit 없이 두면 PostgREST 상한(1000)에 조용히 걸려 '답 기다리는 대화' 일부가
    // 목록에서 사라진다. 여기서 잘리면 화면에는 아무 표시 없이 사람이 없어진다.
    // 실측(2026-08-14) 2행이라 지금은 한 페이지로 끝나지만, 발사 후엔 아니다.
    const since = new Date(Date.now() - RECENT_MANUAL_MS).toISOString();
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: outs, error: outErr } = await supabase
        .from("messages")
        .select("applicant_id, sent_by")
        .eq("direction", "outbound")
        .gte("created_at", since)
        .not("applicant_id", "is", null)
        .range(from, from + PAGE - 1);
      if (outErr) {
        console.error("[message-preview] recent manual query failed", outErr);
        break;
      }
      const page = outs ?? [];
      for (const m of page) {
        if (!AUTO_SENT_BY.has((m.sent_by as string) ?? "")) allIds.add(m.applicant_id as number);
      }
      if (page.length < PAGE) break;
    }
  }

  if (allIds.size === 0) return {};

  const idList = Array.from(allIds);

  const previews: PreviewMap = {};

  /**
   * 메시지 조회는 페이지로 나눈다.
   *
   * 예전엔 limit 없이 한 번에 긁고 JS에서 사람별 첫 행을 골랐다. PostgREST는 상한
   * (기본 1000행)에 닿으면 **오류 없이 조용히 자른다**. 정렬이 created_at desc라
   * 잘리는 쪽은 오래된 대화이고, 그 사람은 미리보기가 아예 없는 상태가 된다 —
   * 그러면 실시간 응대 목록의 통과 조건(최근 답장·답 대기)을 만족시킬 근거가 사라져
   * 화면에서 조용히 없어진다. 빈 목록도 "모두 응대했어요"라는 정상 화면으로 나온다.
   *
   * 실측(2026-08-14): 상위 150명 스캔 858행 — 이미 상한에 가깝다. 답장이 늘면 넘는다.
   * gatherLiveJobLinks(lib/candidate-links.ts)가 같은 이유로 쓰는 페이징 방식을 따른다.
   *
   * 사람마다 필요한 건 '가장 최근 1건'과 '가장 최근 inbound 1건'뿐이므로,
   * 요청한 전원이 채워지면 더 읽지 않고 멈춘다. 보통 첫 페이지에서 끝난다.
   */
  const PAGE = 1000;
  const needInbound = new Set(idList);
  let msgErr: unknown = null;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("messages")
      .select("applicant_id, body, direction, created_at, sent_by")
      .in("applicant_id", idList)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      msgErr = error;
      break;
    }
    const page = data ?? [];
    for (const m of page) {
      const aid = m.applicant_id as number | null;
      if (aid == null) continue;
      if (!previews[aid]) {
        const sentBy = (m.sent_by as string | null) ?? null;
        previews[aid] = {
          body: (m.body as string) ?? "",
          direction: (m.direction as string) ?? "",
          created_at: (m.created_at as string) ?? "",
          sent_by: sentBy,
          manual_outbound: m.direction === "outbound" && !AUTO_SENT_BY.has(sentBy ?? ""),
          last_inbound_at: null,
          pending_draft: false,
        };
      }
      if (previews[aid].last_inbound_at == null && m.direction === "inbound") {
        previews[aid].last_inbound_at = (m.created_at as string) ?? null;
        needInbound.delete(aid);
      }
    }
    // 마지막 페이지이거나, 요청한 전원의 최신 메시지+최신 inbound를 이미 찾았으면 멈춘다.
    if (page.length < PAGE) break;
    if (needInbound.size === 0 && Object.keys(previews).length >= idList.length) break;
  }
  if (msgErr) {
    console.error("[message-preview]", msgErr);
    return {};
  }

  const draftRes = await supabase
    .from("message_drafts")
    .select("applicant_id")
    .in("applicant_id", idList)
    .in("status", ["pending", "need_info"]);

  // 초안 보유는 부가정보 — 실패해도 미리보기 자체는 내려준다.
  if (draftRes.error) {
    console.error("[message-preview] drafts query failed", draftRes.error);
  } else {
    for (const d of draftRes.data ?? []) {
      const aid = d.applicant_id as number | null;
      if (aid != null && previews[aid]) previews[aid].pending_draft = true;
    }
  }

  return previews;
}
