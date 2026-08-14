import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { motion } from "motion/react";
import { MessageCircle, Phone, Loader2, MessageSquare } from "lucide-react";
import { ApplicantDetailPanel } from "./ApplicantDetailPanel";

/**
 * '내가 답할 차례' 큐 카드 (내부 매니저용) — 관심 표시 큐(InterestQueueCard)와 대칭.
 * 미답 지원자('마지막 메시지가 inbound')를 카드로 나열해,
 * 가장 hot한 신호가 흩어지지 않게 모은다. (열람만으로는 큐에서 빠지지 않는다)
 *
 * 판정에 applicants.unread_count는 쓰지 않는다. 그 값은 '답장이 왔는데 스레드를 아직 한 번도 열지 않았다'는
 * 신호다(messages BEFORE INSERT 트리거 trg_match_applicant가 inbound마다 +1, 스레드를 열면 서버가 0으로 리셋)
 * — 열람만으로 지워지므로 '답했는가'를 뜻하지 않는다(실데이터도 전원 0 = 이미 다 열어봤다).
 * 대시보드 '지금 할 일'도 자체 계산을 버리고 이 카드가 올려주는 수(onCountsChange)를 쓴다 — 두 곳이 어긋나지 않게.
 * 카드에서 대화 스레드를 바로 열어(상세 드로어의 대화 탭) 매니저가 즉시 수동 응대할 수 있다.
 *
 * 데이터는 새 엔드포인트 없이 /api/admin/applicants(파이프라인·대시보드와 동일 SWR 키라 dedup)를
 * 재사용하고, 마지막 답장 미리보기만 /api/admin/messages/preview로 가볍게 덧붙인다.
 *
 * 미착수 / 응대중 구분:
 *   - 응대중 = agent_stage === "paused" (매니저가 이미 개입해 수동 응대 중인 건).
 *   - 미착수 = 그 외(활성 대화 없이 다시 연락 문자에 답장만 온 사람 등). 매니저 착수가 아직 없는 상태.
 */

interface AppRow {
  id: number;
  name: string;
  phone: string | null;
  status: string;
  agent_stage?: string | null;
  last_message_at?: string | null;
  created_at?: string | null;
  sms_opt_out_at?: string | null;
  current_job_id?: number | null;
}

interface JobLite {
  id: number;
  title: string;
}

interface Preview {
  body: string;
  direction: string;
  created_at: string;
  last_inbound_at?: string | null;
}

// 미답 건을 잃지 않도록 미리보기 조회 대상을 넓게 잡는 기간(최근 답장 기준)
const RECENT_INBOUND_MS = 14 * 24 * 60 * 60 * 1000;

function agoLabel(iso: string | null | undefined, now: number): string {
  if (!iso) return "-";
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

// initialJobId — 대시보드 긴급 건 등에서 특정 공고 소속만 보도록 진입 시 자동 선택(선택).
// onCountsChange — 계산된 건수를 부모(대시보드 '지금 할 일')에 올린다. 판정 공식을 한 곳에만 두기 위한 것.
export function ReplyQueueCard({
  initialJobId,
  onCountsChange,
}: {
  initialJobId?: number | null;
  onCountsChange?: (counts: { total: number; untouched: number }) => void;
} = {}) {
  const { data, error, mutate } = useSWR<{ data?: AppRow[] }>("/api/admin/applicants", { refreshInterval: 60_000 }); // 살아있는 갱신
  // 공고 제목 매핑용 — Jobs 탭과 동일 SWR 키라 중복 호출을 dedup. 실패해도 필터만 미노출.
  const { data: jobsRes } = useSWR<{ jobs?: JobLite[] }>("/api/admin/jobs?status=all");
  const jobTitleById = useMemo(() => {
    const m = new Map<number, string>();
    for (const j of jobsRes?.jobs ?? []) m.set(j.id, j.title);
    return m;
  }, [jobsRes]);

  // 미리보기 조회 대상: 최근 14일 내 inbound가 있는 지원자(last_message_at은 inbound 수신 시각).
  // 열람 여부는 보지 않는다 — 열람만 하고 답장하지 않은 건을 놓치지 않기 위해.
  const previewTargets = useMemo(() => {
    const rows = data?.data ?? [];
    return rows.filter((a) => a.last_message_at && Date.now() - new Date(a.last_message_at).getTime() < RECENT_INBOUND_MS);
  }, [data]);

  // 마지막 메시지 미리보기 — 조회 대상에 한해서만 가볍게 조회. (미답 판정에도 사용)
  const [previewById, setPreviewById] = useState<Record<number, Preview>>({});
  const idsKey = previewTargets.map((a) => a.id).join(",");
  // 매니저가 답장해도 last_message_at(=inbound 시각)은 그대로여서 조회 대상 집합이 바뀌지 않는다 →
  // idsKey만 보면 미리보기가 영원히 stale이고 처리한 건이 큐·대시보드에 계속 남는다. 명시적 재조회 신호를 둔다.
  const [previewNonce, setPreviewNonce] = useState(0);
  useEffect(() => {
    if (!idsKey) {
      setPreviewById({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/messages/preview?ids=${idsKey}`);
        if (res.ok && !cancelled) {
          const json = await res.json();
          setPreviewById(json.previews ?? {});
        }
      } catch {
        /* 미리보기는 부가정보 — 실패해도 큐 자체는 보여준다 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idsKey, previewNonce]);

  // 미답 판정(실시간 응대 탭과 동일): '마지막 메시지가 inbound'.
  const allItems = useMemo(() => {
    return previewTargets
      .filter((a) => previewById[a.id]?.direction === "inbound")
      .sort((a, b) => {
        const at = new Date(a.last_message_at ?? a.created_at ?? 0).getTime();
        const bt = new Date(b.last_message_at ?? b.created_at ?? 0).getTime();
        return bt - at;
      });
  }, [previewTargets, previewById]);

  // 공고별 필터 — 진행 중 공고 포인터(current_job_id) 기준. 큐에 등장하는 공고들로 옵션 구성.
  const [jobFilter, setJobFilter] = useState<number | "all">(initialJobId ?? "all");
  useEffect(() => {
    if (initialJobId != null) setJobFilter(initialJobId);
  }, [initialJobId]);
  const jobOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const it of allItems) {
      const jid = it.current_job_id;
      if (typeof jid === "number" && !m.has(jid)) m.set(jid, jobTitleById.get(jid) ?? `공고 #${jid}`);
    }
    return Array.from(m, ([id, title]) => ({ id, title }));
  }, [allItems, jobTitleById]);
  // 선택 공고가 큐에서 사라지면 전체로 되돌린다.
  useEffect(() => {
    if (jobFilter !== "all" && !jobOptions.some((o) => o.id === jobFilter)) setJobFilter("all");
  }, [jobFilter, jobOptions]);

  const items = jobFilter === "all" ? allItems : allItems.filter((it) => it.current_job_id === jobFilter);

  const count = items.length;
  // 미착수 = 매니저가 아직 개입 안 함(paused 아님). paused 건은 '사람 확인 필요'로 따로 집계된다.
  const untouchedCount = useMemo(() => items.filter((a) => a.agent_stage !== "paused").length, [items]);

  // 계산된 건수를 부모에 올린다 — 대시보드 '지금 할 일'이 같은 수를 쓰게(공식 중복 금지).
  // 공고 필터가 걸린 상태의 수를 올리면 대시보드가 축소된 수를 보여주므로 전체(allItems) 기준으로 올린다.
  const onCountsRef = useRef(onCountsChange);
  onCountsRef.current = onCountsChange;
  const allUntouched = useMemo(() => allItems.filter((a) => a.agent_stage !== "paused").length, [allItems]);
  useEffect(() => {
    onCountsRef.current?.({ total: allItems.length, untouched: allUntouched });
  }, [allItems.length, allUntouched]);

  // 상대시각을 화면에 머무는 동안 갱신 (InterestQueueCard와 동일 1분 틱)
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const [detailId, setDetailId] = useState<number | null>(null);

  return (
    <motion.div
      id="reply-queue"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.34 }}
      className="scroll-mt-6 bg-white border border-border-strong rounded-lg p-6 shadow-sm flex flex-col"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-[15px] font-bold text-foreground flex items-center gap-1.5">
            <MessageCircle size={15} className="text-info" /> 내가 답할 차례
          </h2>
          <div className="text-[12px] text-muted-foreground mt-0.5">문자 답장이 온 지원자 · 대화를 열어 매니저가 직접 응대</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* 공고별 필터 — 큐에 2개 이상 공고가 섞였을 때만 노출(컨텍스트 연결) */}
          {jobOptions.length > 1 && (
            <select
              value={jobFilter === "all" ? "all" : String(jobFilter)}
              onChange={(e) => setJobFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
              className="pr-8 max-w-[180px] text-[12px] font-bold text-gray-700 bg-white border border-border-strong rounded-lg px-2.5 py-1 outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-ring"
              title="진행 중 공고별로 답할 차례인 지원자를 걸러 봅니다"
            >
              <option value="all">전체 공고</option>
              {jobOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.title}</option>
              ))}
            </select>
          )}
          {untouchedCount > 0 && (
            <span className="flex items-center gap-1 text-[12px] font-bold text-error-strong bg-error-soft border border-error/30 px-2.5 py-1 rounded-full">
              미착수 {untouchedCount}건
            </span>
          )}
          <span className="text-[12px] font-bold text-gray-700 bg-background border border-border-strong px-2.5 py-1 rounded-full">
            총 {count}건
          </span>
        </div>
      </div>

      {error ? (
        <div className="py-4 text-center text-[13px] text-error-strong">목록을 불러오지 못했어요. 잠시 후 페이지를 새로고침해 주세요.</div>
      ) : !data ? (
        <div className="py-4 flex items-center justify-center text-[13px] text-muted-foreground">
          <Loader2 size={15} className="animate-spin mr-1.5" /> 불러오는 중…
        </div>
      ) : items.length === 0 ? (
        <div className="py-4 text-center text-[13px] text-muted-foreground">지금 답할 차례인 지원자가 없어요. 다시 연락 문자에 답장이 오면 여기에 표시됩니다.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((it) => {
            const untouched = it.agent_stage !== "paused";
            const pv = previewById[it.id];
            const optOut = !!it.sms_opt_out_at;
            return (
              <div
                key={it.id}
                className={`flex items-center gap-3 p-3 border rounded-xl ${untouched ? "border-error/30 bg-error-soft" : "border-border-strong bg-white"}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[13px] font-bold text-foreground">{it.name || "이름 미상"}</span>
                    <span
                      className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded-full border ${untouched ? "bg-error-soft text-error-strong border-error/30" : "bg-yellow-100 text-warning-strong border-yellow-300"}`}
                    >
                      {untouched ? "미착수" : "응대중"}
                    </span>
                    {optOut && (
                      <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded-full border bg-error-soft text-error-strong border-error/30">수신거부</span>
                    )}
                  </div>
                  <div className="text-[11.5px] text-muted-foreground truncate mt-0.5">
                    {pv?.body ? (
                      <>
                        <span className="font-semibold text-info">{pv.direction === "inbound" ? "답장" : "발신"}</span>
                        <span className="text-muted-foreground"> · </span>
                        {pv.body}
                      </>
                    ) : (
                      <span className="text-muted-foreground">미리보기 없음</span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                    수신 {agoLabel(it.last_message_at ?? it.created_at, nowTick)}
                    {it.phone && (
                      <>
                        <span className="text-muted-foreground"> · </span>
                        <a
                          href={`tel:${it.phone}`}
                          onClick={(e) => e.stopPropagation()}
                          className="relative inline-flex items-center gap-0.5 rounded text-info after:absolute after:-inset-2 after:content-[''] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Phone size={11} /> {it.phone}
                        </a>
                      </>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => setDetailId(it.id)}
                  className="flex items-center gap-1 text-[11.5px] font-bold text-white bg-foreground hover:bg-gray-800 px-3 py-1.5 rounded-lg shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <MessageSquare size={13} /> 대화 열기
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* 상세 드로어를 대화 탭으로 바로 열어 매니저가 즉시 응대.
          매니저가 답장하면 '마지막 메시지'가 발신으로 바뀌므로, 닫힐 때/변경 시 목록을 재검증해 큐에서 빠지게 한다. */}
      <ApplicantDetailPanel
        isOpen={detailId != null}
        onClose={() => {
          setDetailId(null);
          void mutate();
          setPreviewNonce((n) => n + 1);
        }}
        applicantId={detailId}
        /* 진행 중 공고 포인터를 함께 넘긴다 — 없으면 여러 공고를 진행하는 사람에게 AI 끄기·재개가
           '어느 공고인지 골라 주세요'(409)로 막히는데, 이 화면엔 공고 선택기가 없다. */
        jobId={items.find((i) => i.id === detailId)?.current_job_id ?? null}
        initialTab="chat"
        onChanged={() => {
          void mutate();
          setPreviewNonce((n) => n + 1);
        }}
      />
    </motion.div>
  );
}
