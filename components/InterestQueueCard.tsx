import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { motion } from "motion/react";
import { Heart, Zap, Phone, Loader2, ExternalLink, Check, XCircle, Send, X } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";
import { ApplicantDetailPanel } from "./ApplicantDetailPanel";

/**
 * 관심 표시 처리 대기 카드 (내부 매니저용).
 * 맞춤 공고 링크에서 '관심 있어요'를 누른 후보(agent_stage IS NULL, 미컨택)를 큐로 보여준다.
 * 매니저가 상세 확인 → 빠른 컨택(문자 발송+처리) / 컨택 완료(발송 없이 처리) / 보류로 처리하며,
 * 상세에서 확정·부적합 처리하면 자동으로 큐에서 빠진다.
 * 카드 톤·마크업은 SosLedgerCard와 일관되게 맞춘다.
 *
 * ⚠️ 확정 뉘앙스 금지: 컨택 문구는 "담당 매니저가 곧 연락드릴게요" 수준의 정보성만.
 * 근무 확정/배정을 암시하는 표현은 두지 않는다(확정은 매니저).
 */

interface QueueItem {
  candidate_id: number;
  applicant_id: number;
  name: string | null;
  phone: string | null;
  availability: string | null;
  sms_opt_out_at: string | null;
  job_id: number;
  job_title: string;
  /** 문구에 실을 공고 값 — 없는 항목은 문구에서 그 줄을 빼고 보낸다(빈칸을 문자로 내보내지 않는다). */
  job_slot?: string | null;
  job_pay?: string | null;
  job_area?: string | null;
  job_vehicle_required?: boolean | null;
  interested_at: string | null;
  immediate: boolean;
}

interface QueueRes {
  items?: QueueItem[];
  count?: number;
  immediate_count?: number;
}

function agoLabel(iso: string | null, now: number): string {
  if (!iso) return "-";
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** 가용성 배지 톤 — 즉시가능/바로가능 초록 강조, 이번주가능 연녹, 그 외/미확인 회색. */
function availabilityBadge(availability: string | null, immediate: boolean) {
  if (immediate || availability === "즉시가능")
    return { label: "즉시가능", cls: "bg-success-soft text-success-strong border-success-soft" };
  if (availability === "이번주가능")
    return { label: "이번주가능", cls: "bg-success-soft text-success-strong border-success/25" };
  if (availability === "휴면")
    return { label: "휴면", cls: "bg-background text-muted-foreground border-border-strong" };
  return { label: "미확인", cls: "bg-background text-muted-foreground border-border-strong" };
}

/**
 * 빠른 컨택 프리필 문구 — **조건을 먼저 알려주고 질문은 하나만** 한다(사장님 승인 2026-08-10).
 *
 * 예전 문구는 "담당 매니저가 곧 연락드릴게요"로 **전화를 약속**했다. 그러면 지원자는 전화를 기다리고
 * 매니저가 병목이 된다 — 실제로는 이 제품이 문자로 문답하도록 만들어져 있는데 문구만 전화를 약속했다.
 * 조건을 먼저 보여주면 안 맞는 분은 답을 하지 않으므로 헛대화가 줄고(실측 1인 평균 4.9턴),
 * 답장이 오면 AI가 이어받을 자연스러운 진입점이 된다.
 *
 * ⚠️ 확정 뉘앙스 금지 — '확정·배정·합격·출근' 금지. "이 조건 괜찮으시면"까지가 한계다.
 * ⚠️ 값이 없는 항목은 **그 줄을 빼고** 보낸다(공고에 급여·집결지가 비어 있는 채로 문자에 빈칸이 나가면 안 된다).
 * ⚠️ 매니저가 발송 전 편집할 수 있다(오발송 방지) — 이건 프리필일 뿐이다.
 */
function prefillContactBody(it: {
  name: string | null;
  job_title: string;
  job_slot?: string | null;
  job_pay?: string | null;
  job_area?: string | null;
  job_vehicle_required?: boolean | null;
}): string {
  const n = (it.name || "").trim();
  const job = (it.job_title || "").trim();
  const head = `[옹고잉] ${n ? `${n}님, ` : ""}${job ? `'${job}' ` : ""}관심 주셔서 감사합니다.`;

  const timeAndPay = [it.job_slot?.trim(), it.job_pay?.trim()].filter(Boolean).join(" / ");
  const placeAndCar = [
    it.job_area?.trim() ? `${it.job_area.trim()} 출발` : "",
    it.job_vehicle_required === true ? "본인 차량 필요" : "",
  ]
    .filter(Boolean)
    .join(" / ");

  const facts = [timeAndPay, placeAndCar].filter(Boolean).map((l) => `- ${l}`);
  return [
    head,
    ...(facts.length > 0 ? ["", ...facts] : []),
    "",
    "이 조건 괜찮으시면 '네'라고 답장 주세요.",
    "물어보실 것이 있으면 편하게 답장 주셔도 됩니다.",
  ].join("\n");
}

// initialJobId — 대시보드 긴급 건 등에서 특정 공고 소속만 보도록 진입 시 자동 선택(선택).
export function InterestQueueCard({ initialJobId }: { initialJobId?: number | null } = {}) {
  const confirm = useConfirm();
  const { data, mutate, error } = useSWR<QueueRes>("/api/admin/interest-queue", { refreshInterval: 30_000 }); // 살아있는 갱신

  const allItems = data?.items ?? [];

  // 공고별 필터 — 여러 급구 동시 진행 시 어느 공고 소속인지 구분. 큐에 등장하는 공고들로 옵션 구성.
  const [jobFilter, setJobFilter] = useState<number | "all">(initialJobId ?? "all");
  useEffect(() => {
    if (initialJobId != null) setJobFilter(initialJobId);
  }, [initialJobId]);
  const jobOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const it of allItems) if (!m.has(it.job_id)) m.set(it.job_id, it.job_title || `공고 #${it.job_id}`);
    return Array.from(m, ([id, title]) => ({ id, title }));
  }, [allItems]);
  // 선택한 공고가 큐에서 사라지면(모두 처리됨) 자동으로 전체로 되돌린다.
  useEffect(() => {
    if (jobFilter !== "all" && !jobOptions.some((o) => o.id === jobFilter)) setJobFilter("all");
  }, [jobFilter, jobOptions]);

  const items = jobFilter === "all" ? allItems : allItems.filter((it) => it.job_id === jobFilter);
  const count = items.length;
  const immediateCount = items.filter((it) => it.immediate).length;
  // **한 사람 = 한 카드** — 공고를 여러 개 동시에 열면 한 분이 여러 공고에 관심을 누르는 것이 기본이 된다.
  // 예전엔 그만큼 줄이 생겨서 매니저가 같은 이름을 N번 처리하고, 지원자는 거의 같은 문자를 N통 받았다.
  // 사람으로 묶고 그 안에서 공고별 줄로 나눈다(사람 확인 필요 큐와 같은 방식).
  // ⚠️ 위 count는 그대로 '건수'다 — 대시보드 배지·헤더 숫자와 어긋나면 안 된다(카드 수 ≠ 건수).
  // Map은 삽입 순서를 유지하므로 서버 정렬(최근 관심 순)이 보존된다.
  const groups = useMemo(() => {
    const byApplicant = new Map<number, QueueItem[]>();
    for (const it of items) {
      const arr = byApplicant.get(it.applicant_id);
      if (arr) arr.push(it);
      else byApplicant.set(it.applicant_id, [it]);
    }
    return Array.from(byApplicant.values());
  }, [items]);

  // '관심 표시 상대시각'이 화면에 머무는 동안 갱신되도록 1분 틱 (SosLedgerCard 경과 라벨과 동일 패턴)
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // 빠른 컨택 모달 — 발송 전 편집 가능한 확인 모달(오발송 방지). 외부 발송이라 반드시 확인을 거친다.
  const [quick, setQuick] = useState<QueueItem | null>(null);
  const [quickBody, setQuickBody] = useState("");
  const [quickSending, setQuickSending] = useState(false);

  const openQuick = (it: QueueItem) => {
    setQuick(it);
    setQuickBody(prefillContactBody(it));
  };

  // 발송(성공) → 이어서 contacted 스탬프. contacted_at은 발송 성공 후에만 찍는다.
  const handleQuickSend = async () => {
    if (!quick || quickSending) return;
    if (!quick.phone) {
      toast.error("이 후보는 전화번호가 없어 발송할 수 없어요.");
      return;
    }
    const body = quickBody.trim();
    if (!body) {
      toast.error("보낼 문구가 비어 있어요.");
      return;
    }
    setQuickSending(true);
    try {
      const sendRes = await fetch("/api/admin/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: quick.applicant_id, phone: quick.phone, body, sent_by: "manager" }),
      });
      const sendJson = await sendRes.json().catch(() => ({}));
      if (!sendRes.ok) {
        toast.error(sendJson.error || "문자 발송에 실패했어요");
        return;
      }
      // 발송은 이미 성공한 시점 — contacted 처리 실패가 '발송 실패'로 오표시되지 않게 분리 처리.
      try {
        const markRes = await fetch("/api/admin/interest-queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidate_id: quick.candidate_id, action: "contacted" }),
        });
        if (!markRes.ok) {
          const mj = await markRes.json().catch(() => ({}));
          toast.error(mj.error || "문자는 보냈지만 큐 처리에 실패했어요. [컨택 완료]로 다시 처리해주세요.");
        } else {
          toast.success("문자를 보내고 컨택 완료로 처리했어요.");
        }
      } catch {
        toast.error("문자는 보냈지만 큐 처리에 실패했어요. [컨택 완료]로 다시 처리해주세요.");
      }
      setQuick(null);
      await mutate();
    } catch {
      toast.error("문자 발송에 실패했어요");
    } finally {
      setQuickSending(false);
    }
  };

  const handleAction = async (candidateId: number, action: "contacted" | "dismiss") => {
    if (action === "contacted") {
      if (!(await confirm({
        title: "발송 없이 컨택 완료로 처리할까요?",
        description: "문자를 보내지 않고 처리만 합니다(직접 전화 등으로 이미 연락한 경우). 문자를 보내려면 [빠른 컨택]을 쓰세요.",
        confirmText: "발송 없이 처리",
      }))) return;
    } else {
      if (!(await confirm({ title: "이 관심 표시를 보류할까요?", description: "목록에서 제외됩니다.", confirmText: "보류", destructive: true }))) return;
    }
    setBusyId(candidateId);
    try {
      const res = await fetch("/api/admin/interest-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_id: candidateId, action }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "처리에 실패했어요");
        return;
      }
      toast.success(action === "contacted" ? "발송 없이 컨택 완료로 처리했어요" : "관심 표시를 보류했어요");
      await mutate();
    } catch {
      toast.error("처리에 실패했어요");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <motion.div
      id="interest-queue"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.32 }}
      className="scroll-mt-6 bg-white border border-border-strong rounded-lg p-6 shadow-sm flex flex-col"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-[15px] font-bold text-foreground flex items-center gap-1.5">
            <Heart size={15} className="text-error" /> 관심 표시 처리 대기
          </h2>
          <div className="text-[12px] text-muted-foreground mt-0.5">맞춤 공고 링크에서 관심을 누른 후보 · 상세 확인 후 컨택/보류로 처리</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* 공고별 필터 — 큐에 2개 이상 공고가 섞였을 때만 노출(컨텍스트 연결) */}
          {jobOptions.length > 1 && (
            <select
              value={jobFilter === "all" ? "all" : String(jobFilter)}
              onChange={(e) => setJobFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
              className="pr-8 max-w-[180px] text-[12px] font-bold text-gray-700 bg-white border border-border-strong rounded-lg px-2.5 py-1 outline-none focus:border-brand-yellow focus-visible:ring-2 focus-visible:ring-brand-yellow/40"
              title="공고별로 관심 표시를 필터링합니다"
            >
              <option value="all">전체 공고</option>
              {jobOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.title}</option>
              ))}
            </select>
          )}
          {immediateCount > 0 && (
            <span className="flex items-center gap-1 text-[12px] font-bold text-success-strong bg-success-soft border border-success-soft px-2.5 py-1 rounded-full">
              <Zap size={12} /> 바로가능 {immediateCount}건
            </span>
          )}
          <span className="text-[12px] font-bold text-gray-700 bg-background border border-border-strong px-2.5 py-1 rounded-full">
            총 {count}건
          </span>
        </div>
      </div>

      {error ? (
        <div className="py-4 text-center text-[13px] text-error">목록을 불러오지 못했어요. 잠시 후 페이지를 새로고침해 주세요.</div>
      ) : !data ? (
        <div className="py-4 flex items-center justify-center text-[13px] text-muted-foreground">
          <Loader2 size={15} className="animate-spin mr-1.5" /> 불러오는 중…
        </div>
      ) : items.length === 0 ? (
        <div className="py-4 text-center text-[13px] text-muted-foreground">처리 대기 중인 관심 표시가 없어요. 다시 연락 문자를 받은 후보가 맞춤 공고 링크에서 관심을 누르면 여기에 표시됩니다.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((rows) => {
            const head = rows[0];
            const multi = rows.length > 1;
            const badge = availabilityBadge(head.availability, rows.some((r) => r.immediate));
            const optOut = !!head.sms_opt_out_at;
            return (
              <div
                key={head.applicant_id}
                className={`border rounded-xl ${rows.some((r) => r.immediate) ? "border-success-soft bg-success-soft" : "border-border-strong bg-white"}`}
              >
                {/* 사람 머리글 — 이름·가용성·연락처는 한 번만. 공고가 여러 건이면 그 사실을 눈에 띄게 알린다. */}
                <div className="flex items-center gap-2 flex-wrap px-3 pt-3 pb-1.5">
                  <span className="text-[13px] font-bold text-foreground">{head.name || "이름 미상"}</span>
                  {rows.some((r) => r.immediate) && (
                    <span className="flex items-center gap-0.5 text-[10.5px] font-bold text-success-strong">
                      <Zap size={11} /> 바로 가능
                    </span>
                  )}
                  <span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
                  {optOut && (
                    <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded-full border bg-error-soft text-error-strong border-error/30">수신거부</span>
                  )}
                  {multi && (
                    <span
                      className="text-[10.5px] font-bold px-1.5 py-0.5 rounded-full bg-error-soft text-error-strong"
                      title="이 한 분이 여러 공고에 관심을 눌렀어요 — 전화는 한 번만 하고 아래에서 공고별로 처리하세요"
                    >
                      공고 {rows.length}건
                    </span>
                  )}
                  {head.phone && (
                    <a
                      href={`tel:${head.phone}`}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-0.5 text-[11.5px] font-semibold text-info hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40"
                    >
                      <Phone size={11} /> {head.phone}
                    </a>
                  )}
                  <div className="flex-1" />
                  <button
                    onClick={() => setDetailId(head.applicant_id)}
                    className="flex items-center gap-1 text-[11.5px] font-bold text-gray-700 bg-white border border-border-strong hover:bg-background px-3 py-1.5 rounded-lg shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40"
                  >
                    <ExternalLink size={13} /> 상세
                  </button>
                </div>
                {multi && (
                  <p className="px-3 pb-1 text-[11px] font-semibold text-error-strong leading-snug">
                    같은 분이에요 — 문자를 공고마다 보내면 거의 같은 내용을 {rows.length}통 받게 됩니다. 한 건만 보내고 나머지는 [컨택 완료]로 처리하세요.
                  </p>
                )}
                {rows.map((it) => {
                  const busy = busyId === it.candidate_id;
                  return (
                    <div key={it.candidate_id} className="flex items-center gap-2 mx-2 mb-2 px-2.5 py-2 rounded-lg border border-muted bg-white flex-wrap">
                      <div className="flex-1 min-w-0 text-[11.5px] text-muted-foreground truncate">
                        <span className="font-semibold text-gray-700">{it.job_title}</span>
                        <span className="text-muted-foreground"> · </span>
                        관심 {agoLabel(it.interested_at, nowTick)}
                      </div>
                      <button
                        onClick={() => openQuick(it)}
                        disabled={busy || !it.phone}
                        title={it.phone ? "공고 맥락 문자를 보내고 컨택 완료로 처리" : "전화번호가 없어 문자 발송 불가"}
                        className="flex items-center gap-1 text-[11.5px] font-bold text-white bg-foreground hover:bg-gray-800 px-3 py-1.5 rounded-lg shrink-0 transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40"
                      >
                        <Send size={13} /> 빠른 컨택
                      </button>
                      <button
                        onClick={() => handleAction(it.candidate_id, "contacted")}
                        disabled={busy}
                        title="문자 발송 없이 처리 (직접 전화 등으로 이미 연락한 경우)"
                        className="flex items-center gap-1 text-[11.5px] font-bold text-gray-700 bg-white border border-border-strong hover:bg-background px-3 py-1.5 rounded-lg shrink-0 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40"
                      >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} 컨택 완료
                      </button>
                      <button
                        onClick={() => handleAction(it.candidate_id, "dismiss")}
                        disabled={busy}
                        title="보류"
                        className="flex items-center gap-1 text-[11.5px] font-bold text-muted-foreground bg-white border border-border-strong hover:bg-background hover:text-error px-2.5 py-1.5 rounded-lg shrink-0 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/40"
                      >
                        <XCircle size={13} /> 보류
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* 빠른 컨택 모달 — 실제 문자 발송 전 편집·확인(오발송 방지). 발송 성공 후 컨택 완료 스탬프. */}
      {quick && (
        <div
          className="fixed inset-0 bg-foreground/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          onClick={() => !quickSending && setQuick(null)}
        >
          <div className="bg-glass-3 backdrop-blur-xl border border-white w-full max-w-[500px] rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-border-strong">
              <h2 className="text-[16px] font-extrabold text-foreground flex items-center gap-2"><Send size={16} className="text-info" /> 빠른 컨택</h2>
              <button aria-label="빠른 처리 창 닫기" onClick={() => setQuick(null)} disabled={quickSending} className="text-muted-foreground hover:text-gray-700 disabled:opacity-50 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40"><X size={20} /></button>
            </div>
            <div className="p-6 flex flex-col gap-3">
              <div className="text-[12.5px] text-muted-foreground leading-relaxed">
                <b className="text-gray-700">{quick.name || "이름 미상"}</b>님({quick.phone})에게 <b className="text-error">실제 문자</b>가 발송됩니다. 아래 내용을 확인·편집한 뒤 보내세요.
                {quick.job_title && (
                  <>
                    <br />
                    관심 공고: <b className="text-gray-700">{quick.job_title}</b>
                  </>
                )}
              </div>
              <textarea
                value={quickBody}
                onChange={(e) => setQuickBody(e.target.value)}
                rows={5}
                disabled={quickSending}
                className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-[13.5px] leading-relaxed focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow resize-none disabled:bg-background"
              />
              <div className="text-[11px] text-muted-foreground leading-relaxed">
                발송에 성공하면 자동으로 <b>컨택 완료</b>로 처리돼 큐에서 빠집니다. 근무 확정·배정을 약속하는 문구는 넣지 마세요.
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border-strong">
              <button onClick={() => setQuick(null)} disabled={quickSending} className="px-4 py-2 rounded-lg text-[13.5px] font-bold text-gray-700 hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40">취소</button>
              <button onClick={handleQuickSend} disabled={quickSending || !quickBody.trim()} className="px-5 py-2 rounded-lg text-[13.5px] font-bold text-white bg-foreground hover:bg-gray-800 disabled:opacity-60 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40">
                {quickSending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} 문자 보내고 처리
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 상세 드로어 — 닫힐 때 큐 갱신(상세에서 확정/부적합 처리하면 자동으로 큐에서 빠짐) */}
      <ApplicantDetailPanel
        isOpen={detailId != null}
        onClose={() => {
          setDetailId(null);
          void mutate();
        }}
        applicantId={detailId}
        /* 관심을 누른 그 공고를 넘긴다 — 공고 선택기가 없는 화면에서 AI 끄기·재개가 막히지 않게. */
        jobId={items.find((i) => i.applicant_id === detailId)?.job_id ?? null}
        onChanged={() => void mutate()}
      />
    </motion.div>
  );
}
