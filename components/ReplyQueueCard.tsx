import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { motion } from "motion/react";
import { MessageCircle, Phone, Loader2, MessageSquare } from "lucide-react";
import { ApplicantDetailPanel } from "./ApplicantDetailPanel";

/**
 * 답장 대기 큐 카드 (내부 매니저용) — 관심 표시 큐(InterestQueueCard)와 대칭.
 * 미응답 inbound가 있는 지원자(unread_count>0)를 카드로 나열해, 가장 hot한 신호가 흩어지지 않게 모은다.
 * 카드에서 대화 스레드를 바로 열어(상세 드로어의 대화 탭) 매니저가 즉시 수동 응대할 수 있다.
 *
 * 데이터는 새 엔드포인트 없이 /api/admin/applicants(파이프라인·대시보드와 동일 SWR 키라 dedup)를
 * 재사용하고, 마지막 답장 미리보기만 /api/admin/messages/preview로 가볍게 덧붙인다.
 *
 * 미착수 / 응대중 구분:
 *   - 응대중 = agent_stage === "paused" (매니저가 이미 개입해 수동 응대 중인 건).
 *   - 미착수 = 그 외(활성 대화 없이 답장만 온 재컨택 응답자 등). 매니저 착수가 아직 없는 상태.
 */

interface AppRow {
  id: number;
  name: string;
  phone: string | null;
  status: string;
  unread_count?: number | null;
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
}

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
export function ReplyQueueCard({ initialJobId }: { initialJobId?: number | null } = {}) {
  const { data, error, mutate } = useSWR<{ data?: AppRow[] }>("/api/admin/applicants");
  // 공고 제목 매핑용 — Jobs 탭과 동일 SWR 키라 중복 호출을 dedup. 실패해도 필터만 미노출.
  const { data: jobsRes } = useSWR<{ jobs?: JobLite[] }>("/api/admin/jobs?status=all");
  const jobTitleById = useMemo(() => {
    const m = new Map<number, string>();
    for (const j of jobsRes?.jobs ?? []) m.set(j.id, j.title);
    return m;
  }, [jobsRes]);

  // 미응답 inbound가 있는 지원자 = unread_count>0. 최근 수신 순으로.
  const allItems = useMemo(() => {
    const rows = data?.data ?? [];
    return rows
      .filter((a) => (a.unread_count ?? 0) > 0)
      .sort((a, b) => {
        const at = new Date(a.last_message_at ?? a.created_at ?? 0).getTime();
        const bt = new Date(b.last_message_at ?? b.created_at ?? 0).getTime();
        return bt - at;
      });
  }, [data]);

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
  // 미착수 = 매니저가 아직 개입 안 함(paused 아님). '오늘의 할 일'의 poolReplies와 동일 관점.
  const untouchedCount = useMemo(() => items.filter((a) => a.agent_stage !== "paused").length, [items]);

  // 상대시각을 화면에 머무는 동안 갱신 (InterestQueueCard와 동일 1분 틱)
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // 마지막 메시지 미리보기 — 큐에 있는 지원자에 한해서만 가볍게 조회.
  const [previewById, setPreviewById] = useState<Record<number, Preview>>({});
  const idsKey = items.map((a) => a.id).join(",");
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
  }, [idsKey]);

  const [detailId, setDetailId] = useState<number | null>(null);

  return (
    <motion.div
      id="reply-queue"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.34 }}
      className="scroll-mt-6 bg-white border border-[#E2E8F0] rounded-[16px] p-6 shadow-sm flex flex-col"
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-[15px] font-bold text-[#1A202C] flex items-center gap-1.5">
            <MessageCircle size={15} className="text-[#3182CE]" /> 답장 대기
          </h2>
          <div className="text-[12px] text-[#718096] mt-0.5">문자 답장이 온 지원자 · 대화를 열어 매니저가 직접 응대</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* 공고별 필터 — 큐에 2개 이상 공고가 섞였을 때만 노출(컨텍스트 연결) */}
          {jobOptions.length > 1 && (
            <select
              value={jobFilter === "all" ? "all" : String(jobFilter)}
              onChange={(e) => setJobFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
              className="max-w-[180px] text-[12px] font-bold text-[#4A5568] bg-white border border-[#E2E8F0] rounded-lg px-2.5 py-1 outline-none focus:border-[#FFCB3C] focus-visible:ring-2 focus-visible:ring-[#FFCB3C]/40"
              title="진행 중 공고별로 답장 대기를 필터링합니다"
            >
              <option value="all">전체 공고</option>
              {jobOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.title}</option>
              ))}
            </select>
          )}
          {untouchedCount > 0 && (
            <span className="flex items-center gap-1 text-[12px] font-bold text-[#C53030] bg-[#FFF5F5] border border-[#FEB2B2] px-2.5 py-1 rounded-full">
              미착수 {untouchedCount}건
            </span>
          )}
          <span className="text-[12px] font-bold text-[#4A5568] bg-[#F7FAFC] border border-[#E2E8F0] px-2.5 py-1 rounded-full">
            총 {count}건
          </span>
        </div>
      </div>

      {error ? (
        <div className="py-4 text-center text-[13px] text-[#E53E3E]">큐를 불러오지 못했어요.</div>
      ) : !data ? (
        <div className="py-4 flex items-center justify-center text-[13px] text-[#A0AEC0]">
          <Loader2 size={15} className="animate-spin mr-1.5" /> 불러오는 중…
        </div>
      ) : items.length === 0 ? (
        <div className="py-4 text-center text-[13px] text-[#A0AEC0]">답장 대기 중인 지원자가 없어요.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((it) => {
            const untouched = it.agent_stage !== "paused";
            const pv = previewById[it.id];
            const optOut = !!it.sms_opt_out_at;
            return (
              <div
                key={it.id}
                className={`flex items-center gap-3 p-3 border rounded-xl ${untouched ? "border-[#FEB2B2] bg-[#FFF5F5]" : "border-[#E2E8F0] bg-white"}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[13px] font-bold text-[#1A202C]">{it.name || "이름 미상"}</span>
                    {(it.unread_count ?? 0) > 0 && (
                      <span className="min-w-4 h-4 px-1 rounded-full bg-[#E53E3E] text-white text-[10px] font-bold flex items-center justify-center">{it.unread_count}</span>
                    )}
                    <span
                      className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded border ${untouched ? "bg-[#FFF5F5] text-[#C53030] border-[#FEB2B2]" : "bg-[#FEFCBF] text-[#B7791F] border-[#F6E05E]"}`}
                    >
                      {untouched ? "미착수" : "응대중"}
                    </span>
                    {optOut && (
                      <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded border bg-[#FFF5F5] text-[#C53030] border-[#FEB2B2]">수신거부</span>
                    )}
                  </div>
                  <div className="text-[11.5px] text-[#718096] truncate mt-0.5">
                    {pv?.body ? (
                      <>
                        <span className="font-semibold text-[#3182CE]">{pv.direction === "inbound" ? "답장" : "발신"}</span>
                        <span className="text-[#CBD5E0]"> · </span>
                        {pv.body}
                      </>
                    ) : (
                      <span className="text-[#A0AEC0]">미리보기 없음</span>
                    )}
                  </div>
                  <div className="text-[11px] text-[#A0AEC0] truncate mt-0.5">
                    수신 {agoLabel(it.last_message_at ?? it.created_at, nowTick)}
                    {it.phone && (
                      <>
                        <span className="text-[#CBD5E0]"> · </span>
                        <a
                          href={`tel:${it.phone}`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-0.5 text-[#3182CE] hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
                        >
                          <Phone size={11} /> {it.phone}
                        </a>
                      </>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => setDetailId(it.id)}
                  className="flex items-center gap-1 text-[11.5px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] px-3 py-1.5 rounded-lg shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
                >
                  <MessageSquare size={13} /> 대화 열기
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* 상세 드로어를 대화 탭으로 바로 열어 매니저가 즉시 응대.
          대화 열람 시 서버가 unread_count=0으로 리셋하므로, 닫힐 때/변경 시 목록을 재검증해 큐에서 빠지게 한다. */}
      <ApplicantDetailPanel
        isOpen={detailId != null}
        onClose={() => {
          setDetailId(null);
          void mutate();
        }}
        applicantId={detailId}
        initialTab="chat"
        onChanged={() => void mutate()}
      />
    </motion.div>
  );
}
