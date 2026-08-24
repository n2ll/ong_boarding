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
  /** 가장 최근 미처리 초안의 공고. 대화를 열 때 그 공고 탭으로 바로 이동한다. */
  pending_draft_job_id: number | null;
}

export type PreviewMap = Record<number, LastMessagePreview>;

const POSTGREST_PAGE_SIZE = 1_000;
const APPLICANT_ID_BATCH_SIZE = 250;
const MAX_PARALLEL_BATCHES = 3;
const LIVE_ACTIVE_STATUSES = new Set(["스크리닝 중", "스크리닝 완료"]);

/** `/live`가 미리보기로 판정해야 하는 전원. 사람 수로 자르지 않고 원래 순서를 유지한다. */
export function livePreviewTargetIds(
  applicants: ({ id: number } & Record<string, unknown>)[],
  now = Date.now(),
): number[] {
  const recentCut = now - RECENT_MANUAL_MS;
  return applicants.flatMap((applicant) => {
    const stage = typeof applicant.agent_stage === "string" ? applicant.agent_stage : null;
    const status = typeof applicant.status === "string" ? applicant.status : "";
    const activityValue = applicant.last_message_at ?? applicant.created_at ?? 0;
    const activityAt = typeof activityValue === "string" || typeof activityValue === "number"
      ? new Date(activityValue).getTime()
      : 0;
    const isBase = (stage !== null && stage !== "abort") || LIVE_ACTIVE_STATUSES.has(status);
    return isBase || applicant.last_message_at != null || activityAt > recentCut
      ? [applicant.id]
      : [];
  });
}

function applicantIdBatches(ids: number[]): number[][] {
  const batches: number[][] = [];
  for (let index = 0; index < ids.length; index += APPLICANT_ID_BATCH_SIZE) {
    batches.push(ids.slice(index, index + APPLICANT_ID_BATCH_SIZE));
  }
  return batches;
}

async function mapBatches<T>(
  batches: number[][],
  worker: (ids: number[]) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (let index = 0; index < batches.length; index += MAX_PARALLEL_BATCHES) {
    results.push(...await Promise.all(
      batches.slice(index, index + MAX_PARALLEL_BATCHES).map(worker),
    ));
  }
  return results;
}

/**
 * @param ids          미리보기를 뽑을 지원자. withManual이 켜지면 여기에 합집합이 더해진다.
 * @param withManual   최근 14일 내 매니저 수동 발신이 있는 지원자를 서버가 찾아 ids에 합친다.
 *                     호출자가 메시지 이력 보유자 전원을 이미 ids에 넣었다면 필요하지 않다.
 * @param requireComplete 수동 발신 탐색·메시지·초안 중 하나라도 실패하면 부분 결과 대신 throw한다.
 */
export async function gatherMessagePreviews(
  supabase: SupabaseClient,
  ids: number[],
  opts: { withManual?: boolean; throwOnCoreError?: boolean; requireComplete?: boolean } = {},
): Promise<PreviewMap> {
  const allIds = new Set<number>(ids.filter((n) => Number.isFinite(n)));

  if (opts.withManual) {
    // 최근 14일 outbound 전량 스캔 — 캠페인 벌크 발송 한 번이면 수천 행이 된다.
    // limit 없이 두면 PostgREST 상한(1000)에 조용히 걸려 '답 기다리는 대화' 일부가
    // 목록에서 사라진다. 여기서 잘리면 화면에는 아무 표시 없이 사람이 없어진다.
    // 실측(2026-08-14) 2행이라 지금은 한 페이지로 끝나지만, 발사 후엔 아니다.
    const since = new Date(Date.now() - RECENT_MANUAL_MS).toISOString();
    for (let from = 0; ; from += POSTGREST_PAGE_SIZE) {
      const { data: outs, error: outErr } = await supabase
        .from("messages")
        .select("id, applicant_id, sent_by, created_at")
        .eq("direction", "outbound")
        .gte("created_at", since)
        .not("applicant_id", "is", null)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + POSTGREST_PAGE_SIZE - 1);
      if (outErr) {
        console.error("[message-preview] recent manual query failed", outErr);
        if (opts.requireComplete) throw outErr;
        break;
      }
      const page = outs ?? [];
      for (const m of page) {
        if (!AUTO_SENT_BY.has((m.sent_by as string) ?? "")) allIds.add(m.applicant_id as number);
      }
      if (page.length < POSTGREST_PAGE_SIZE) break;
    }
  }

  if (allIds.size === 0) return {};

  const idList = Array.from(allIds);

  const previews: PreviewMap = {};
  const batches = applicantIdBatches(idList);

  /**
   * 사람을 잘라내지 않고 쿼리만 250명씩 나눈다. 한 번의 거대한 `.in(...)`은 URL·DB 부하를
   * 실제로 제한하지 못하면서, 라우트에서 사람을 500명으로 자르면 가장 오래된 미답이 먼저
   * 사라졌다. 각 묶음 안의 행은 PostgREST 1000행 단위로 끝까지 읽는다.
   *
   * 사람마다 필요한 건 '가장 최근 1건'과 '가장 최근 inbound 1건'뿐이므로 둘을 모두 찾으면
   * 그 묶음은 일찍 멈춘다. 같은 created_at 경계가 페이지마다 흔들리지 않게 id를 2차 정렬한다.
   */
  try {
    const messageMaps = await mapBatches(batches, async (batchIds) => {
      const batchPreviews: PreviewMap = {};
      const needInbound = new Set(batchIds);

      for (let from = 0; ; from += POSTGREST_PAGE_SIZE) {
        const { data, error } = await supabase
          .from("messages")
          .select("id, applicant_id, body, direction, created_at, sent_by")
          .in("applicant_id", batchIds)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, from + POSTGREST_PAGE_SIZE - 1);
        if (error) throw error;

        const page = data ?? [];
        for (const m of page) {
          const aid = m.applicant_id as number | null;
          if (aid == null) continue;
          if (!batchPreviews[aid]) {
            const sentBy = (m.sent_by as string | null) ?? null;
            batchPreviews[aid] = {
              body: (m.body as string) ?? "",
              direction: (m.direction as string) ?? "",
              created_at: (m.created_at as string) ?? "",
              sent_by: sentBy,
              manual_outbound: m.direction === "outbound" && !AUTO_SENT_BY.has(sentBy ?? ""),
              last_inbound_at: null,
              pending_draft: false,
              pending_draft_job_id: null,
            };
          }
          if (batchPreviews[aid].last_inbound_at == null && m.direction === "inbound") {
            batchPreviews[aid].last_inbound_at = (m.created_at as string) ?? null;
            needInbound.delete(aid);
          }
        }
        if (page.length < POSTGREST_PAGE_SIZE) break;
        if (needInbound.size === 0 && Object.keys(batchPreviews).length >= batchIds.length) break;
      }

      return batchPreviews;
    });
    for (const messageMap of messageMaps) Object.assign(previews, messageMap);
  } catch (error) {
    console.error("[message-preview]", error);
    if (opts.throwOnCoreError || opts.requireComplete) throw error;
    return {};
  }

  // 초안도 같은 ID 묶음·행 페이지 규칙으로 전부 읽는다. requireComplete 호출자는 초안 배지까지
  // 하나의 스냅샷으로 쓰므로, 어느 묶음이든 실패하면 부분 결과를 정상 목록으로 돌려보내지 않는다.
  try {
    // 메시지가 없는 지원자의 초안은 아래에서도 붙일 preview가 없어 예전부터 무시했다.
    // 그 ID를 DB에 다시 보내지 않아 빈 초안 조회를 줄인다.
    const draftBatches = applicantIdBatches(idList.filter((id) => previews[id] !== undefined));
    const draftMaps = await mapBatches(draftBatches, async (batchIds) => {
      const needDraft = new Set(batchIds);
      const drafts = new Map<number, number | null>();

      for (let from = 0; needDraft.size > 0; from += POSTGREST_PAGE_SIZE) {
        const draftRes = await supabase
          .from("message_drafts")
          .select("id, applicant_id, job_id, created_at")
          .in("applicant_id", batchIds)
          .in("status", ["pending", "need_info"])
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, from + POSTGREST_PAGE_SIZE - 1);
        if (draftRes.error) throw draftRes.error;

        const page = draftRes.data ?? [];
        for (const d of page) {
          const aid = d.applicant_id as number | null;
          if (aid == null || !previews[aid] || !needDraft.has(aid)) continue;
          needDraft.delete(aid);
          drafts.set(aid, typeof d.job_id === "number" ? d.job_id : null);
        }
        if (page.length < POSTGREST_PAGE_SIZE) break;
      }

      return drafts;
    });

    for (const draftMap of draftMaps) {
      for (const [aid, jobId] of draftMap) {
        previews[aid].pending_draft = true;
        previews[aid].pending_draft_job_id = jobId;
      }
    }
  } catch (error) {
    console.error("[message-preview] drafts query failed", error);
    if (opts.requireComplete) throw error;
  }

  return previews;
}
