/**
 * 한 사람이 지금 붙어 있는 공고들 — **"살아있는 결속"의 단일 정의**.
 *
 * 공고 6~7개를 동시에 열면 한 사람이 여러 공고에 동시에 붙는 것이 기본 상태가 된다.
 * 그때 매니저 화면 세 곳이 서로 다른 답을 내면 안 된다:
 *   · 인력풀 목록 배지("공고 3건")
 *   · 응대 화면 상단 공고 탭
 *   · 지원자 상세의 공고 목록·포커스
 * **목록에 3건이라고 적혀 있으면 열었을 때 탭도 3개**여야 한다. 그래서 판정을 여기 한 곳에 둔다.
 *
 * '살아있는 결속'의 정의:
 *   - `agent_stage`가 `abort`(종료)가 아닌 `job_candidates` 행. **NULL(관심만 누른 상태)도 포함한다.**
 *     예전에는 응대 화면 탭이 NULL을 제외해서, 관심을 5개 눌러둔 사람에게도 탭이 안 떴다 —
 *     발사 후에는 NULL이 다수 상태가 되므로 그 제외가 곧 "안 보이는 결속"이 된다.
 *   - 시스템 더미 공고(`__` 프리픽스) 제외 · 실질 마감 공고 제외(`isJobEffectivelyClosed`).
 *   - 먼저 붙은 순(created_at 오름차순).
 *
 * ⚠️ 확정 뉘앙스 금지 — 여기서 나오는 것은 '결속'일 뿐이고 확정·배정이 아니다. 라벨은 화면이 정한다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isJobEffectivelyClosed, isSystemJobTitle } from "./jobs";
import { fetchAllPostgrestRows } from "./admin/postgrest-pagination";

export interface LiveJobLink {
  job_id: number;
  title: string;
  branch: string | null;
  /** null = 관심만 누른 상태(아직 대화 전). 'paused' = 사람 확인 필요. 그 외 = AI 응대 단계. */
  agent_stage: string | null;
  created_at: string | null;
  /** 단계가 마지막으로 바뀐 시각(행 updated_at) — paused면 '며칠째 사람을 기다리는지'의 근사값.
      다른 update로도 갱신될 수 있어 정확한 pause 시각은 아니지만, 목록 배지용 근사로 충분하다. */
  stage_updated_at: string | null;
}

/**
 * 결속 하나가 '살아있는지' 판단 — 마감 여부가 **이미 계산된** 경우용.
 * 서버가 `job_effectively_closed`를 내려주는 화면(지원자 상세)이 같은 기준을 쓰게 하기 위한 입구다.
 * 판정식은 이 함수 하나뿐이고 `isLiveLink`도 여기로 위임한다 — 같은 개념 두 공식 금지.
 */
export function isLiveLinkResolved(args: {
  agentStage: string | null | undefined;
  jobTitle: string | null | undefined;
  jobEffectivelyClosed: boolean;
}): boolean {
  if (args.agentStage === "abort") return false;
  if (typeof args.jobTitle !== "string" || isSystemJobTitle(args.jobTitle)) return false;
  if (args.jobEffectivelyClosed) return false;
  return true;
}

/** 결속 하나가 '살아있는지' 판단 — 목록·탭·상세가 공유하는 유일한 기준. */
export function isLiveLink(args: {
  agentStage: string | null | undefined;
  jobTitle: string | null | undefined;
  jobStatus: string | null | undefined;
  jobClosesAt: string | null | undefined;
}): boolean {
  return isLiveLinkResolved({
    agentStage: args.agentStage,
    jobTitle: args.jobTitle,
    jobEffectivelyClosed: isJobEffectivelyClosed(args.jobStatus, args.jobClosesAt),
  });
}

/**
 * 여러 지원자의 살아있는 결속을 한 번에 조회한다(목록 배지용 일괄 조회).
 * 반환: applicantId → 결속 배열(먼저 붙은 순). 결속이 없는 사람은 Map에 키가 없다.
 */
export async function gatherLiveJobLinks(
  supabase: SupabaseClient,
  applicantIds: number[]
): Promise<{ links: Map<number, LiveJobLink[]>; error: string | null }> {
  const ids = [...new Set(applicantIds.filter((n) => Number.isFinite(n)))];
  const links = new Map<number, LiveJobLink[]>();
  if (ids.length === 0) return { links, error: null };

  // 지원자가 많으면 단일 IN URL 자체가 과대해진다. 250명씩 나누고 각 묶음도 PostgREST
  // 기본 상한(1000행) 뒤까지 읽어, 배지가 조용히 사라지는 부분 성공을 막는다.
  // 종료(abort)는 어차피 버릴 행이라 DB에서 먼저 뺀다 — 단 NULL(관심)은 반드시 남겨야 한다
  // (`.neq("agent_stage","abort")`만 쓰면 NULL이 통째로 빠져 이 모듈의 존재 이유가 사라진다).
  const ID_BATCH_SIZE = 250;
  const idBatches: number[][] = [];
  for (let offset = 0; offset < ids.length; offset += ID_BATCH_SIZE) {
    idBatches.push(ids.slice(offset, offset + ID_BATCH_SIZE));
  }

  let rows: Record<string, unknown>[];
  try {
    const rowsByBatch = await Promise.all(idBatches.map((idBatch) =>
      fetchAllPostgrestRows(async (from, to) => {
        const result = await supabase
          .from("job_candidates")
          .select("id, applicant_id, job_id, agent_stage, created_at, updated_at, jobs:job_id ( id, title, branch, status, closes_at )")
          .in("applicant_id", idBatch)
          .or("agent_stage.is.null,agent_stage.neq.abort")
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to);
        return {
          data: result.data as unknown as Record<string, unknown>[] | null,
          error: result.error,
        };
      }, "지원자 공고 연결")
    ));
    rows = rowsByBatch.flat();
  } catch (error) {
    const message = typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : "지원자 공고 연결 조회 실패";
    return {
      links,
      error: message,
    };
  }

  for (const row of rows) {
    const j = (row.jobs ?? null) as unknown as
      | { id: number; title: string | null; branch: string | null; status: string | null; closes_at: string | null }
      | null;
    if (!j) continue;
    if (
      !isLiveLink({
        agentStage: row.agent_stage as string | null,
        jobTitle: j.title,
        jobStatus: j.status,
        jobClosesAt: j.closes_at,
      })
    ) {
      continue;
    }
    const applicantId = row.applicant_id as number;
    const arr = links.get(applicantId) ?? [];
    arr.push({
      job_id: j.id,
      title: j.title as string,
      branch: j.branch ?? null,
      agent_stage: (row.agent_stage as string | null) ?? null,
      created_at: (row.created_at as string | null) ?? null,
      stage_updated_at: (row.updated_at as string | null) ?? null,
    });
    links.set(applicantId, arr);
  }
  return { links, error: null };
}

/**
 * 탭·포커스의 기본 선택 — **대화가 진행 중인 공고를 우선**한다.
 * 관심만 누른 공고(stage NULL)가 먼저 생겼다는 이유로 기본 탭이 되면, 매니저가 빈 대화창을 먼저 본다.
 */
export function defaultFocusJobId(list: LiveJobLink[], wanted?: number | null): number | null {
  if (wanted != null && list.some((l) => l.job_id === wanted)) return wanted;
  const talking = list.find((l) => l.agent_stage != null && l.agent_stage !== "paused");
  if (talking) return talking.job_id;
  const paused = list.find((l) => l.agent_stage === "paused");
  if (paused) return paused.job_id;
  return list.length > 0 ? list[0].job_id : null;
}

/** 결속 배열 요약 — 목록 배지 문구용. 진행/관심 건수를 분리해 센다(확정 뉘앙스 금지). */
export function summarizeLinks(list: LiveJobLink[]): { total: number; talking: number; paused: number; interest: number } {
  let talking = 0;
  let paused = 0;
  let interest = 0;
  for (const l of list) {
    if (l.agent_stage == null) interest += 1;
    else if (l.agent_stage === "paused") paused += 1;
    else talking += 1;
  }
  return { total: list.length, talking, paused, interest };
}
