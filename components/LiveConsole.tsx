"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Search, X, AlertTriangle, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { ConversationThread } from "./ConversationThread";
import { ApplicantDetailContent } from "./ApplicantDetailPanel";
import { useConfirm } from "./ConfirmDialog";
import { getBrowserClient } from "@/lib/supabase";

interface Applicant {
  id: number;
  name: string;
  phone: string | null;
  status: string;
  unread_count?: number | null;
  agent_stage?: string | null;
  source?: string | null;
  branch?: string | null;
  branch1?: string | null;
  created_at?: string | null;
  last_message_at?: string | null;
  sms_opt_out_at?: string | null;
}

interface ActiveJob {
  job_id: number;
  title: string;
  branch: string | null;
  agent_stage: string | null;
}

interface Handoff {
  candidate_id: number;
  applicant_id: number;
  job_id: number;
  applicant_name: string;
  phone: string | null;
  job_title: string;
  branch: string | null;
  reason: string | null;
  category: string;
  category_label: string;
  tone: "urgent" | "answerable" | "human" | "neutral";
  suggested_action: string;
  is_system_job: boolean;
  paused_at: string;
  age_days: number;
}

interface ConfirmPending {
  applicant_id: number;
  name: string;
  phone: string | null;
  branch: string | null;
  baemin_id: string | null;
  job_id: number | null;
  job_title: string | null;
  start_date: string | null;
  pickup_address: string | null;
  site_manager_name: string | null;
  site_manager_phone: string | null;
  can_send_venue: boolean;
}

// 인계 카테고리 배지 색(tone 기반). urgent=빨강, answerable=호박, human=파랑, neutral=회색
const TONE_STYLE: Record<Handoff["tone"], string> = {
  urgent: "bg-[#FFF5F5] text-[#C53030] border-[#FEB2B2]",
  answerable: "bg-[#FFFBEB] text-[#B7791F] border-[#FAF089]",
  human: "bg-[#EBF8FF] text-[#2B6CB0] border-[#BEE3F8]",
  neutral: "bg-[#F7FAFC] text-[#4A5568] border-[#E2E8F0]",
};

/** 방치 경과일 색 — 오래될수록 빨강(SLA 환기). */
function ageStyle(days: number): string {
  if (days >= 7) return "text-[#C53030]";
  if (days >= 3) return "text-[#DD6B20]";
  return "text-[#718096]";
}

const STAGE_KO: Record<string, string> = {
  exploration: "탐색",
  screening: "스크리닝",
  onboarding: "온보딩",
  active: "활동 중",
  paused: "수동 전환",
  abort: "중단",
};

const AVATAR_PALETTE = [
  { bg: "#EBF8FF", fg: "#3182CE" },
  { bg: "#FEFCBF", fg: "#D69E2E" },
  { bg: "#F0FFF4", fg: "#38A169" },
  { bg: "#FAF5FF", fg: "#805AD5" },
  { bg: "#FFF5F5", fg: "#E53E3E" },
];

const SOURCE_LABEL: Record<string, string> = {
  danggeun: "당근",
  baemin: "배민",
  danggeun_practice: "당근(연습)",
  manual: "수기",
  direct: "직접지원",
  facebook: "페이스북",
  naver: "네이버",
};

function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금 전";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

const ACTIVE_STATUSES = new Set(["스크리닝 중", "스크리닝 완료"]);

export function LiveConsole() {
  const confirm = useConfirm();
  const [activeTab, setActiveTab] = useState<"all" | "intervention" | "confirm">("all");
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [previewById, setPreviewById] = useState<Record<number, { body: string; direction: string; created_at: string }>>({});
  // 멀티-잡: 선택된 지원자가 동시에 진행 중인 공고들 + 현재 보고 있는 공고
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  // 인계 작업 큐(paused 후보) + 카테고리 필터 + 큐에서 선택한 공고 포커스용
  const [handoffCat, setHandoffCat] = useState<string>("all");
  // 인계 큐에서 특정 공고로 포커스해 열 때 사용(ref라 effect 재실행을 유발하지 않음)
  const focusJobIdRef = useRef<number | null>(null);
  // 인계 → 자산화(③-1): 매니저 답변을 공고 단가·정책 필드에 반영하는 모달
  const [promote, setPromote] = useState<Handoff | null>(null);
  const [promoteField, setPromoteField] = useState<"pay_info" | "policy_notes">("pay_info");
  const [promoteText, setPromoteText] = useState("");
  const [promoteLoading, setPromoteLoading] = useState(false);
  const [promoteSaving, setPromoteSaving] = useState(false);
  // 인계 → 지식 자산화(③-2): 매니저 답변을 공통/지점 지식으로 승인 등록하는 모달
  const [kb, setKb] = useState<Handoff | null>(null);
  const [kbTarget, setKbTarget] = useState<"common" | "branch">("common");
  const [kbTitle, setKbTitle] = useState("");
  const [kbBody, setKbBody] = useState("");
  const [kbLoading, setKbLoading] = useState(false);
  const [kbSaving, setKbSaving] = useState(false);

  // 대화 목록은 applicants를 SWR로 — 타 탭과 동일 키라 dedup·캐시(탭 재방문 시 즉시 표시).
  const { data: appsData, isLoading: appsLoading, mutate: mutateApps } = useSWR<{ data?: Applicant[] }>("/api/admin/applicants");
  const chats = useMemo(
    () => (appsData?.data ?? []).filter((a) => (a.agent_stage && a.agent_stage !== "abort") || ACTIVE_STATUSES.has(a.status)),
    [appsData]
  );
  const loadingList = appsLoading && chats.length === 0;

  // 인계 큐도 SWR로 캐시.
  const { data: handoffsData, mutate: mutateHandoffs } = useSWR<{ handoffs?: Handoff[] }>("/api/admin/agent/handoffs");
  const handoffs = useMemo(() => handoffsData?.handoffs ?? [], [handoffsData]);

  // 확정 대기 큐(온보딩 완료·미확정) SWR.
  const { data: confirmData, mutate: mutateConfirm } = useSWR<{ pending?: ConfirmPending[] }>("/api/admin/confirm/pending");
  const confirmPending = useMemo(() => confirmData?.pending ?? [], [confirmData]);

  // 전역 킬스위치 상태 — 꺼져 있으면 목록 상단 경고 배너 + 스레드 배지·입력창 동작이 바뀐다.
  // env_forced(AGENT_DISABLED=1)도 토글과 무관하게 항상 중단이므로 함께 '전역 중지'로 취급.
  const { data: killData } = useSWR<{ disabled?: boolean; env_forced?: boolean }>("/api/admin/agent/kill-switch");
  const globalKill = killData?.disabled === true || killData?.env_forced === true;

  // 발송 미리보기 모달(내용·비용 확인 후 발송) — 첫날규칙/만남장소 공용
  const [sendModal, setSendModal] = useState<{ p: ConfirmPending; kind: "venue" | "first_day" } | null>(null);
  const [venueDate, setVenueDate] = useState("");
  const [preview, setPreview] = useState<{ text: string; sms_type: string; cost_krw: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sendSaving, setSendSaving] = useState(false);

  const loadChats = useCallback(() => { void mutateApps(); }, [mutateApps]);
  const loadHandoffs = useCallback(() => { void mutateHandoffs(); }, [mutateHandoffs]);

  // 대화 상태가 바뀌면(재개/보류/발송 등) 목록과 인계 큐를 함께 새로고침.
  const handleChanged = useCallback(() => {
    void mutateApps();
    void mutateHandoffs();
    void mutateConfirm();
  }, [mutateApps, mutateHandoffs, mutateConfirm]);

  // 첫 선택 자동 지정.
  useEffect(() => {
    setSelectedChatId((prev) => prev ?? (chats[0]?.id ?? null));
  }, [chats]);

  // 활성 대화 subset의 마지막 메시지 미리보기를 가볍게 조회(목록이 갱신될 때).
  useEffect(() => {
    const ids = chats.map((c) => c.id);
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const pRes = await fetch(`/api/admin/messages/preview?ids=${ids.join(",")}`);
        if (pRes.ok && !cancelled) {
          const pJson = await pRes.json();
          setPreviewById(pJson.previews ?? {});
        }
      } catch {
        /* 미리보기는 부가정보이므로 실패 무시 */
      }
    })();
    return () => { cancelled = true; };
  }, [chats]);

  // 실시간 갱신(③): DB 트리거가 messages/job_candidates 변경 시 'live-console' 토픽으로
  // PII 없는 "changed" 신호만 broadcast → 받으면 디바운스 후 목록·인계 큐를 재조회한다.
  // (테이블 직접 구독이 아니라 공개 broadcast라 anon에 데이터가 노출되지 않는다.)
  useEffect(() => {
    const supabase = getBrowserClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel("live-console")
      .on("broadcast", { event: "changed" }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          loadChats();
          loadHandoffs();
          void mutateConfirm();
        }, 800);
      })
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [loadChats, loadHandoffs, mutateConfirm]);

  // 선택 지원자가 바뀌면 그 사람이 동시에 진행 중인 공고 목록을 불러온다.
  // 2건 이상이면 대화창 상단에 공고 탭이 떠서 공고별로 스레드·체크리스트·AI 토글이 분리된다.
  useEffect(() => {
    if (selectedChatId == null) {
      setActiveJobs([]);
      setSelectedJobId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/applicants/${selectedChatId}/active-jobs`);
        const json = await res.json();
        if (cancelled) return;
        const jobs = (json.jobs ?? []) as ActiveJob[];
        setActiveJobs(jobs);
        // 인계 큐에서 특정 공고를 골라 들어왔으면 그 공고로 포커스, 아니면 첫 번째(없으면 전체).
        const fj = focusJobIdRef.current;
        const wanted = fj != null && jobs.some((j) => j.job_id === fj) ? fj : null;
        setSelectedJobId(wanted ?? (jobs.length > 0 ? jobs[0].job_id : null));
        focusJobIdRef.current = null;
      } catch {
        if (!cancelled) {
          setActiveJobs([]);
          setSelectedJobId(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedChatId]);

  const activeChat = chats.find((c) => c.id === selectedChatId) ?? null;

  // 인계 큐: 카테고리 필터 적용(이미 오래된 순으로 서버 정렬됨)
  const visibleHandoffs = handoffCat === "all" ? handoffs : handoffs.filter((h) => h.category === handoffCat);
  // 카테고리 칩에 쓸 집계
  const catCounts = handoffs.reduce<Record<string, number>>((acc, h) => {
    acc[h.category] = (acc[h.category] ?? 0) + 1;
    return acc;
  }, {});
  const catOrder = Array.from(new Set(handoffs.map((h) => h.category)));

  // 큐에서 한 건 선택 → 해당 지원자 대화 + 그 공고로 포커스
  const selectHandoff = (h: Handoff) => {
    focusJobIdRef.current = h.job_id;
    if (h.applicant_id === selectedChatId) {
      // 이미 보고 있는 지원자의 '다른 공고' 인계를 고른 경우: selectedChatId가 그대로라
      // active-jobs 로딩 effect가 재실행되지 않으므로 공고 탭을 직접 전환한다.
      setSelectedJobId(h.job_id);
    } else {
      setSelectedChatId(h.applicant_id);
    }
  };

  // 처리 완료 → AI 재개. 큐에서 즉시 제거되도록 새로고침.
  const resumeHandoff = async (h: Handoff) => {
    try {
      const res = await fetch("/api/admin/agent/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: h.applicant_id, job_id: h.job_id }),
      });
      if (!res.ok) throw new Error();
      toast.success(`${h.applicant_name}님 — AI 응대를 재개했어요.`);
      handleChanged();
    } catch {
      toast.error("재개에 실패했어요.");
    }
  };

  // '공고에 반영' 모달 열기 — 매니저가 직접 보낸 마지막 답변/현재 공고값으로 프리필
  const openPromote = async (h: Handoff) => {
    const field: "pay_info" | "policy_notes" = h.category === "pay" ? "pay_info" : "policy_notes";
    setPromote(h);
    setPromoteField(field);
    setPromoteText("");
    setPromoteLoading(true);
    try {
      const res = await fetch(`/api/admin/agent/handoffs/promote?candidate_id=${h.candidate_id}`);
      const json = await res.json();
      if (res.ok) {
        const current = field === "pay_info" ? json.current_pay_info : json.current_policy_notes;
        setPromoteText(json.last_manual_reply ?? current ?? "");
      }
    } catch {
      /* 프리필 실패해도 빈 칸으로 진행 가능 */
    } finally {
      setPromoteLoading(false);
    }
  };

  const savePromote = async () => {
    if (!promote) return;
    const text = promoteText.trim();
    if (!text) return toast.error("반영할 내용을 입력해주세요.");
    setPromoteSaving(true);
    try {
      const res = await fetch("/api/admin/agent/handoffs/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_id: promote.candidate_id, field: promoteField, text }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "반영에 실패했어요");
        return;
      }
      toast.success("공고에 반영했어요. 다음부터 AI가 이 질문에 직접 답합니다.");
      setPromote(null);
    } catch {
      toast.error("반영에 실패했어요");
    } finally {
      setPromoteSaving(false);
    }
  };

  // '공통지식 등록' 모달 열기 — 질문 요지(인계 사유) + 매니저 마지막 답변으로 프리필
  const openKb = async (h: Handoff) => {
    setKb(h);
    setKbTarget("common");
    setKbTitle(h.reason ? h.reason.slice(0, 40) : "");
    setKbBody("");
    setKbLoading(true);
    try {
      const res = await fetch(`/api/admin/agent/handoffs/promote?candidate_id=${h.candidate_id}`);
      const json = await res.json();
      if (res.ok) setKbBody(json.last_manual_reply ?? "");
    } catch {
      /* 프리필 실패해도 직접 입력 가능 */
    } finally {
      setKbLoading(false);
    }
  };

  const saveKb = async () => {
    if (!kb) return;
    const title = kbTitle.trim();
    const body = kbBody.trim();
    if (!title || !body) return toast.error("제목과 내용을 입력해주세요.");
    if (kbTarget === "branch" && !kb.branch) return toast.error("이 건은 지점 정보가 없어 공통으로만 등록할 수 있어요.");
    setKbSaving(true);
    try {
      const res = await fetch("/api/admin/agent/handoffs/promote-kb", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: kbTarget, title, body, branch_name: kb.branch ?? undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "등록에 실패했어요");
        return;
      }
      toast.success(kbTarget === "common" ? "공통 지식에 등록했어요. 다음부터 AI가 참고합니다." : `${kb.branch} 지점 지식에 등록했어요.`);
      setKb(null);
    } catch {
      toast.error("등록에 실패했어요");
    } finally {
      setKbSaving(false);
    }
  };

  // ── 확정 대기 액션 (내용·비용 미리보기 → 발송) ──
  const fetchPreview = useCallback(async (p: ConfirmPending, kind: "venue" | "first_day", startDate?: string) => {
    setPreviewLoading(true);
    setPreview(null);
    try {
      const res = await fetch("/api/admin/confirm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: p.applicant_id, kind, job_id: p.job_id, start_date: startDate, preview: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error || "미리보기 실패"); return; }
      setPreview({ text: json.text, sms_type: json.sms_type, cost_krw: json.cost_krw });
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const openSend = (p: ConfirmPending, kind: "venue" | "first_day") => {
    setSendModal({ p, kind });
    setPreview(null);
    const d = p.start_date ?? "";
    setVenueDate(d);
    // 첫날규칙은 시작일 불필요 → 즉시 미리보기. 만남장소는 시작일 있어야 미리보기.
    if (kind === "first_day") void fetchPreview(p, "first_day");
    else if (d) void fetchPreview(p, "venue", d);
  };

  const doSend = async () => {
    if (!sendModal) return;
    const { p, kind } = sendModal;
    if (kind === "venue" && !venueDate) return toast.error("시작일을 선택해주세요.");
    if (!preview) return toast.error("미리보기를 불러온 뒤 발송하세요.");
    setSendSaving(true);
    try {
      const res = await fetch("/api/admin/confirm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: p.applicant_id, kind, job_id: p.job_id, start_date: kind === "venue" ? venueDate : undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "발송 실패");
      toast.success(`${p.name}님 — ${kind === "venue" ? "만남장소 안내" : "첫날 규칙 안내"}를 발송했어요.`);
      setSendModal(null);
      handleChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "발송 실패");
    } finally {
      setSendSaving(false);
    }
  };

  const confirmHire = async (p: ConfirmPending) => {
    if (!(await confirm({
      title: `${p.name}님을 '확정인력'으로 전환할까요?`,
      confirmText: "확정",
    }))) return;
    try {
      const res = await fetch(`/api/admin/applicants/${p.applicant_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "확정인력" }),
      });
      if (!res.ok) throw new Error();
      toast.success(`${p.name}님을 확정인력으로 전환했어요.`);
      handleChanged();
    } catch {
      toast.error("확정 처리에 실패했어요.");
    }
  };

  const visibleChats = chats
    .filter((c) => {
      if (search.trim() && !c.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
      if (stageFilter !== "all") {
        if (stageFilter === "paused") return c.agent_stage === "paused";
        if (stageFilter === "intervention") return (c.unread_count ?? 0) > 0;
        return c.agent_stage === stageFilter;
      }
      return true;
    })
    // SLA 정렬: 미답장(개입 필요)을 최상단, 그 안에서는 가장 오래 기다린 순. 그 외는 최근 활동 순.
    .sort((a, b) => {
      const aInt = (a.unread_count ?? 0) > 0 ? 1 : 0;
      const bInt = (b.unread_count ?? 0) > 0 ? 1 : 0;
      if (aInt !== bInt) return bInt - aInt;
      const at = new Date(a.last_message_at ?? a.created_at ?? 0).getTime();
      const bt = new Date(b.last_message_at ?? b.created_at ?? 0).getTime();
      return aInt === 1 ? at - bt : bt - at;
    });

  return (
    <div className="flex h-full overflow-hidden bg-white">
      {/* Left Sidebar */}
      <div className="w-[320px] flex-shrink-0 border-r border-[#E2E8F0] flex flex-col bg-[#F7FAFC]">
        {/* 전역 킬스위치 경고 — 켜져 있는 줄 알고 기다리는 교착을 방지 */}
        {globalKill && (
          <div className="shrink-0 bg-[#FFFBEB] border-b border-[#F6E05E] px-4 py-2.5 flex items-start gap-2 text-[12px] font-bold text-[#B7791F] leading-snug">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>
              AI 전역 응답이 꺼져 있습니다 — 수동 응대만 발송됩니다 (
              <Link href="/brain" className="underline underline-offset-2">에이전트 두뇌</Link>
              에서 변경)
            </span>
          </div>
        )}
        <div className="p-5 border-b border-[#E2E8F0] bg-white flex flex-col gap-4">
          <Link href="/pipeline" className="w-full bg-[#1A202C] hover:bg-[#2D3748] text-white py-2.5 rounded-xl text-[13px] font-bold transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
            대량 발송은 파이프라인에서 <ArrowRight size={16} />
          </Link>

          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} type="text" placeholder="지원자명 검색" className="w-full pl-9 pr-4 py-2 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] bg-[#F1F4F8]" />
          </div>
          <div className="flex gap-1.5">
            <button onClick={() => setActiveTab("all")} className={`px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${activeTab === "all" ? "bg-[#1A202C] text-white" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>전체 <span className="opacity-60 ml-1">{chats.length}</span></button>
            <button onClick={() => setActiveTab("intervention")} className={`px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${activeTab === "intervention" ? "bg-[#E53E3E] text-white" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>인계 대기 <span className="opacity-60 ml-1">{handoffs.length}</span></button>
            <button onClick={() => setActiveTab("confirm")} className={`px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${activeTab === "confirm" ? "bg-[#2F855A] text-white" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>확정 대기 <span className="opacity-60 ml-1">{confirmPending.length}</span></button>
          </div>
          {/* all 탭: 단계 필터 / 인계 대기 탭: 사유 카테고리 필터 */}
          {activeTab === "all" ? (
            <div className="flex gap-1 flex-wrap">
              {[
                { id: "all", label: "전체" },
                { id: "screening", label: "스크리닝" },
                { id: "onboarding", label: "온보딩" },
                { id: "paused", label: "수동" },
              ].map((f) => (
                <button key={f.id} onClick={() => setStageFilter(f.id)} className={`px-2.5 py-1 rounded-md text-[11.5px] font-bold transition-all ${stageFilter === f.id ? "bg-[#FFCB3C] text-[#1A202C]" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>{f.label}</button>
              ))}
            </div>
          ) : activeTab === "intervention" ? (
            <div className="flex gap-1 flex-wrap">
              <button onClick={() => setHandoffCat("all")} className={`px-2.5 py-1 rounded-md text-[11.5px] font-bold transition-all ${handoffCat === "all" ? "bg-[#FFCB3C] text-[#1A202C]" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>전체 {handoffs.length}</button>
              {catOrder.map((cid) => {
                const sample = handoffs.find((h) => h.category === cid)!;
                return (
                  <button key={cid} onClick={() => setHandoffCat(cid)} className={`px-2.5 py-1 rounded-md text-[11.5px] font-bold transition-all ${handoffCat === cid ? "bg-[#FFCB3C] text-[#1A202C]" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>{sample.category_label} {catCounts[cid]}</button>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* 인계 대기 탭: paused 후보 작업 큐(오래된 순). 카테고리 배지 + 경과일 + 사유 요약. */}
        {activeTab === "intervention" ? (
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
            {visibleHandoffs.length === 0 && <div className="text-[13px] text-[#A0AEC0] p-4 text-center">대기 중인 인계가 없어요</div>}
            {visibleHandoffs.map((h) => {
              const selected = selectedChatId === h.applicant_id && selectedJobId === h.job_id;
              return (
                <div
                  key={h.candidate_id}
                  className={`rounded-xl transition-all ${selected ? "bg-white border border-[#FFCB3C] shadow-sm ring-1 ring-[#FFCB3C]" : "bg-white border border-transparent hover:border-[#E2E8F0]"}`}
                >
                  <button onClick={() => selectHandoff(h)} className="w-full text-left p-3.5 pb-2 cursor-pointer">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className={`px-2 py-0.5 rounded-md text-[11px] font-bold border ${TONE_STYLE[h.tone]}`}>{h.category_label}</span>
                      <span className={`text-[11.5px] font-bold ${ageStyle(h.age_days)}`}>⏱ {h.age_days === 0 ? "오늘" : `${h.age_days}일 방치`}</span>
                    </div>
                    <div className="text-[14px] font-bold text-[#1A202C] mb-0.5 flex items-center gap-1.5">
                      {h.applicant_name}
                      {h.branch && <span className="px-1.5 py-0.5 rounded text-[10.5px] font-bold bg-[#F0FFF4] text-[#2F855A]">{h.branch}</span>}
                    </div>
                    {h.reason && <div className="text-[12px] text-[#4A5568] line-clamp-2 leading-snug">{h.reason}</div>}
                  </button>
                  <div className="flex items-center justify-between gap-2 px-3.5 pb-2.5 pt-0.5">
                    <span className="text-[11px] font-bold text-[#A0AEC0] truncate">→ {h.suggested_action}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {/* 단가·정책 인계는 매니저 답변을 공고에 반영해 다음부터 AI가 직접 답하게 한다(③-1) */}
                      {!h.is_system_job && ["pay", "contract", "policy"].includes(h.category) && (
                        <button
                          onClick={() => openPromote(h)}
                          className="cursor-pointer px-2.5 py-1 rounded-md text-[11.5px] font-bold bg-[#FFFBEC] text-[#B7791F] border border-[#FAF089] hover:bg-[#FEFCBF] transition-colors active:scale-95"
                          title="매니저 답변을 공고 단가·정책 필드에 저장 → 다음부터 AI가 직접 응대"
                        >
                          공고에 반영
                        </button>
                      )}
                      {!["manual", "auto"].includes(h.category) && (
                        <button
                          onClick={() => openKb(h)}
                          className="cursor-pointer px-2.5 py-1 rounded-md text-[11.5px] font-bold bg-[#F0FFF4] text-[#2F855A] border border-[#C6F6D5] hover:bg-[#E6FFFA] transition-colors active:scale-95"
                          title="매니저 답변을 공통/지점 지식에 등록 → 다음부터 AI가 직접 응대"
                        >
                          지식 등록
                        </button>
                      )}
                      <button
                        onClick={() => resumeHandoff(h)}
                        className="cursor-pointer px-2.5 py-1 rounded-md text-[11.5px] font-bold bg-[#EBF8FF] text-[#2B6CB0] hover:bg-[#BEE3F8] transition-colors active:scale-95"
                        title="처리 완료 — AI 응대를 다시 켜고 큐에서 제거"
                      >
                        AI 재개
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : activeTab === "confirm" ? (
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
            {confirmPending.length === 0 && <div className="text-[13px] text-[#A0AEC0] p-4 text-center">확정 대기 중인 지원자가 없어요</div>}
            {confirmPending.map((p) => {
              const selected = selectedChatId === p.applicant_id;
              return (
                <div key={p.applicant_id} className={`rounded-xl transition-all ${selected ? "bg-white border border-[#FFCB3C] shadow-sm ring-1 ring-[#FFCB3C]" : "bg-white border border-transparent hover:border-[#E2E8F0]"}`}>
                  <button onClick={() => setSelectedChatId(p.applicant_id)} className="w-full text-left p-3.5 pb-2 cursor-pointer">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="px-2 py-0.5 rounded-md text-[11px] font-bold border bg-[#F0FFF4] text-[#2F855A] border-[#C6F6D5]">온보딩 완료</span>
                      {p.baemin_id && <span className="text-[11px] font-bold text-[#718096]">ID {p.baemin_id}</span>}
                    </div>
                    <div className="text-[14px] font-bold text-[#1A202C] mb-0.5 flex items-center gap-1.5">
                      {p.name}
                      {p.branch && <span className="px-1.5 py-0.5 rounded text-[10.5px] font-bold bg-[#F0FFF4] text-[#2F855A]">{p.branch}</span>}
                    </div>
                    <div className="text-[12px] text-[#4A5568] leading-snug line-clamp-2">
                      {p.job_title ?? "공고 미지정"}{p.pickup_address ? ` · ${p.pickup_address}` : ""}
                    </div>
                  </button>
                  <div className="flex items-center justify-end gap-1.5 px-3.5 pb-2.5 pt-0.5 flex-wrap">
                    <button onClick={() => openSend(p, "venue")} disabled={!p.can_send_venue} title={p.can_send_venue ? "만남장소 안내 발송 (내용·비용 확인)" : "공고에 픽업주소·현장매니저가 있어야 발송 가능"} className="cursor-pointer px-2.5 py-1 rounded-md text-[11.5px] font-bold bg-[#EBF8FF] text-[#2B6CB0] border border-[#BEE3F8] hover:bg-[#BEE3F8] transition-colors active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed">만남장소 발송</button>
                    <button onClick={() => openSend(p, "first_day")} title="첫날 규칙 안내 발송 (내용·비용 확인)" className="cursor-pointer px-2.5 py-1 rounded-md text-[11.5px] font-bold bg-[#FFFBEC] text-[#B7791F] border border-[#FAF089] hover:bg-[#FEFCBF] transition-colors active:scale-95">첫날규칙</button>
                    <button onClick={() => confirmHire(p)} title="확정인력으로 전환" className="cursor-pointer px-2.5 py-1 rounded-md text-[11.5px] font-bold bg-[#2F855A] text-white hover:bg-[#276749] transition-colors active:scale-95">확정</button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          {loadingList && <div className="text-[13px] text-[#A0AEC0] p-4 text-center">대화 목록 불러오는 중…</div>}
          {!loadingList && visibleChats.length === 0 && <div className="text-[13px] text-[#A0AEC0] p-4 text-center">진행 중인 대화가 없어요</div>}
          {visibleChats.map((chat, idx) => {
            const pal = AVATAR_PALETTE[idx % AVATAR_PALETTE.length];
            const unread = chat.unread_count ?? 0;
            const intervention = unread > 0;
            const src = chat.source ? SOURCE_LABEL[chat.source] ?? chat.source : null;
            return (
              <button
                key={chat.id}
                onClick={() => setSelectedChatId(chat.id)}
                className={`w-full text-left p-3.5 rounded-xl transition-all ${selectedChatId === chat.id ? "bg-white border border-[#FFCB3C] shadow-sm ring-1 ring-[#FFCB3C]" : "bg-white border border-transparent hover:border-[#E2E8F0]"}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm" style={{ backgroundColor: pal.bg, color: pal.fg }}>{chat.name.charAt(0)}</div>
                    <div>
                      <div className="text-[14px] font-bold text-[#1A202C] flex items-center gap-1.5">{chat.name} {unread > 0 && <span className="w-4 h-4 rounded-full bg-[#E53E3E] text-white text-[10px] flex items-center justify-center">{unread}</span>}</div>
                    </div>
                  </div>
                  <div className={`text-[11px] font-semibold ${intervention ? "text-[#E53E3E]" : "text-[#A0AEC0]"}`}>{intervention && "⏱ "}{relTime(chat.last_message_at ?? chat.created_at)}</div>
                </div>
                {(() => {
                  const pv = previewById[chat.id];
                  if (pv?.body) {
                    return (
                      <div className="text-[13px] line-clamp-1 mb-2.5">
                        <span className={`font-bold ${pv.direction === "inbound" ? "text-[#3182CE]" : "text-[#A0AEC0]"}`}>{pv.direction === "inbound" ? "지원자" : "발신"}</span>
                        <span className="text-[#4A5568]"> · {pv.body}</span>
                      </div>
                    );
                  }
                  return <div className="text-[13px] text-[#4A5568] line-clamp-1 mb-2.5">{chat.status}{chat.agent_stage ? ` · ${STAGE_KO[chat.agent_stage] ?? chat.agent_stage}` : ""}</div>;
                })()}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {src && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#F7FAFC] text-[#718096] border border-[#E2E8F0]">{src}</span>}
                  {(chat.branch || chat.branch1) && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#F0FFF4] text-[#2F855A]">{chat.branch || chat.branch1}</span>}
                  {chat.agent_stage === "paused" && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#EDF2F7] text-[#4A5568]">수동(OFF)</span>}
                  {intervention && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#FFF5F5] text-[#E53E3E]">개입 필요</span>}
                  {chat.agent_stage && chat.agent_stage !== "paused" && chat.agent_stage !== "abort" && !intervention && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#EBF8FF] text-[#3182CE]">AI 응대 중</span>}
                </div>
              </button>
            );
          })}
        </div>
        )}
      </div>

      {/* Middle Chat Window */}
      {activeChat ? (
        <div className="flex-1 flex flex-col bg-[#EEF1F5] min-w-0">
          <div className="min-h-[60px] shrink-0 bg-white border-b border-[#E2E8F0] px-6 py-2.5 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-lg font-bold text-[#1A202C]">{activeChat.name} <span className="text-[15px] text-[#718096]">지원자</span></div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {activeChat.source && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#F7FAFC] text-[#718096] border border-[#E2E8F0]">{SOURCE_LABEL[activeChat.source] ?? activeChat.source}</span>}
              {(activeChat.branch || activeChat.branch1) && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#F0FFF4] text-[#2F855A]">{activeChat.branch || activeChat.branch1}</span>}
              {activeChat.agent_stage && <span className={`px-2 py-1 rounded-md text-[11px] font-bold ${activeChat.agent_stage === "paused" ? "bg-[#EDF2F7] text-[#4A5568]" : "bg-[#EBF8FF] text-[#3182CE]"}`}>{STAGE_KO[activeChat.agent_stage] ?? activeChat.agent_stage}</span>}
              <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#FFFBEB] text-[#B7791F] border border-[#FAF089]">{activeChat.status}</span>
            </div>
          </div>

          {/* 멀티-잡 공고 선택 탭 — 동시에 2개 이상 공고를 진행 중일 때만 노출.
              공고별로 스레드/체크리스트/AI 토글이 분리되어, "어느 공고가 매니저 전환됐는지"가 정확히 보인다. */}
          {activeJobs.length > 1 && (
            <div className="shrink-0 bg-white border-b border-[#E2E8F0] px-6 py-2 flex items-center gap-2 overflow-x-auto">
              <span className="text-[11px] font-bold text-[#A0AEC0] shrink-0">진행 공고 {activeJobs.length}건 · 탭 전환</span>
              {activeJobs.map((j) => {
                const selected = selectedJobId === j.job_id;
                const paused = j.agent_stage === "paused";
                const label = (j.branch && j.branch.trim()) || j.title;
                return (
                  <button
                    key={j.job_id}
                    onClick={() => setSelectedJobId(j.job_id)}
                    aria-pressed={selected}
                    className={`shrink-0 cursor-pointer px-3 py-1.5 rounded-lg text-[12px] font-bold transition-all flex items-center gap-1.5 active:scale-95 ${
                      selected
                        ? "bg-[#1A202C] text-white shadow-sm"
                        : "bg-[#F7FAFC] border border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7] hover:border-[#CBD5E0]"
                    }`}
                    title={`${j.title} — 클릭해 이 공고 대화로 전환`}
                  >
                    {label}
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                        paused
                          ? selected ? "bg-[#4A5568] text-white" : "bg-[#EDF2F7] text-[#4A5568]"
                          : selected ? "bg-[#3182CE] text-white" : "bg-[#EBF8FF] text-[#3182CE]"
                      }`}
                    >
                      {paused ? "수동" : STAGE_KO[j.agent_stage ?? ""] ?? "AI"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <ConversationThread
            key={`${activeChat.id}:${selectedJobId ?? "all"}`}
            applicantId={activeChat.id}
            applicantName={activeChat.name}
            phone={activeChat.phone}
            jobId={selectedJobId}
            globalKill={globalKill}
            smsOptOutAt={activeChat.sms_opt_out_at ?? null}
            onChanged={handleChanged}
            className="flex-1 min-h-0"
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center bg-[#EEF1F5] text-[#A0AEC0] text-sm">대화를 선택하세요</div>
      )}

      {/* Right Sidebar — 통합 지원자 상세(컨텍스트) */}
      {activeChat && (
        <div className="w-[340px] shrink-0 bg-white border-l border-[#E2E8F0] flex flex-col">
          <ApplicantDetailContent
            key={`${activeChat.id}:${selectedJobId ?? "all"}`}
            applicantId={activeChat.id}
            jobId={selectedJobId}
            variant="panel"
            onChanged={handleChanged}
          />
        </div>
      )}

      {/* 인계 → 자산화(③-1): 매니저 답변을 공고 단가·정책 필드에 반영 */}
      {promote && (
        <div className="fixed inset-0 bg-[#00000080] z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => !promoteSaving && setPromote(null)}>
          <div className="bg-white w-full max-w-[520px] rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2E8F0]">
              <h2 className="text-[16px] font-extrabold text-[#1A202C]">공고에 반영</h2>
              <button onClick={() => setPromote(null)} className="text-[#A0AEC0] hover:text-[#4A5568]"><X size={20} /></button>
            </div>
            <div className="p-6 flex flex-col gap-4">
              <div className="text-[12.5px] text-[#718096] leading-relaxed">
                <b className="text-[#4A5568]">{promote.job_title}</b> 공고에 반영합니다. 저장하면 다음부터 같은 질문을 AI가 직접 답해 인계가 줄어듭니다.
              </div>
              <div className="flex gap-1.5">
                <button onClick={() => setPromoteField("pay_info")} className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold transition-all ${promoteField === "pay_info" ? "bg-[#1A202C] text-white" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>급여·정산</button>
                <button onClick={() => setPromoteField("policy_notes")} className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold transition-all ${promoteField === "policy_notes" ? "bg-[#1A202C] text-white" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>고용·정책</button>
              </div>
              <textarea
                value={promoteText}
                onChange={(e) => setPromoteText(e.target.value)}
                rows={5}
                disabled={promoteLoading}
                placeholder={promoteLoading ? "불러오는 중…" : promoteField === "pay_info" ? "예: 기본 건당 3,200원 · 매주 정산 · 프로모션 5천원(1~2개월 후 종료 가능)" : "예: 프리랜서(3.3%) 계약, 4대보험 미적용 · 본인 명의 정산"}
                className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-[13.5px] leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none disabled:bg-[#F7FAFC]"
              />
              <div className="text-[11px] text-[#A0AEC0]">매니저가 직접 보낸 마지막 답변을 미리 채웠어요. 공고에 넣을 표준 문구로 다듬어 저장하세요.</div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#E2E8F0]">
              <button onClick={() => setPromote(null)} disabled={promoteSaving} className="px-4 py-2 rounded-lg text-[13.5px] font-bold text-[#4A5568] hover:bg-[#F1F4F8] disabled:opacity-50">취소</button>
              <button onClick={savePromote} disabled={promoteSaving || promoteLoading} className="px-5 py-2 rounded-lg text-[13.5px] font-bold text-white bg-[#B7791F] hover:bg-[#975A16] disabled:opacity-60">{promoteSaving ? "저장 중…" : "공고에 반영"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 인계 → 지식 자산화(③-2): 매니저 답변을 공통/지점 지식으로 승인 등록 */}
      {kb && (
        <div className="fixed inset-0 bg-[#00000080] z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => !kbSaving && setKb(null)}>
          <div className="bg-white w-full max-w-[520px] rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2E8F0]">
              <h2 className="text-[16px] font-extrabold text-[#1A202C]">지식 등록</h2>
              <button onClick={() => setKb(null)} className="text-[#A0AEC0] hover:text-[#4A5568]"><X size={20} /></button>
            </div>
            <div className="p-6 flex flex-col gap-4">
              <div className="text-[12.5px] text-[#718096] leading-relaxed">
                매니저가 검토·승인한 내용만 옹봇 지식이 됩니다. 저장하면 다음부터 같은 질문을 AI가 직접 답해 인계가 줄어듭니다.
              </div>
              <div className="flex gap-1.5">
                <button onClick={() => setKbTarget("common")} className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold transition-all ${kbTarget === "common" ? "bg-[#1A202C] text-white" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>공통(전 지점)</button>
                <button onClick={() => kb.branch && setKbTarget("branch")} disabled={!kb.branch} className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold transition-all disabled:opacity-40 ${kbTarget === "branch" ? "bg-[#1A202C] text-white" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>{kb.branch ? `${kb.branch} 지점만` : "지점 정보 없음"}</button>
              </div>
              <div>
                <label className="block text-[12px] font-bold text-[#4A5568] mb-1.5">제목(무슨 질문인가)</label>
                <input
                  value={kbTitle}
                  onChange={(e) => setKbTitle(e.target.value)}
                  placeholder="예: 배민 커넥트 가입 순서"
                  className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-[13.5px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
                />
              </div>
              <div>
                <label className="block text-[12px] font-bold text-[#4A5568] mb-1.5">내용(AI가 답할 사실)</label>
                <textarea
                  value={kbBody}
                  onChange={(e) => setKbBody(e.target.value)}
                  rows={4}
                  disabled={kbLoading}
                  placeholder={kbLoading ? "불러오는 중…" : "예: 앱에서 본인인증 → 차량 등록 → 안전교육 순서로 진행합니다."}
                  className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-[13.5px] leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none disabled:bg-[#F7FAFC]"
                />
              </div>
              <div className="text-[11px] text-[#A0AEC0]">매니저가 직접 보낸 마지막 답변을 미리 채웠어요. 표준 문구로 다듬어 저장하세요.</div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#E2E8F0]">
              <button onClick={() => setKb(null)} disabled={kbSaving} className="px-4 py-2 rounded-lg text-[13.5px] font-bold text-[#4A5568] hover:bg-[#F1F4F8] disabled:opacity-50">취소</button>
              <button onClick={saveKb} disabled={kbSaving || kbLoading} className="px-5 py-2 rounded-lg text-[13.5px] font-bold text-white bg-[#2F855A] hover:bg-[#276749] disabled:opacity-60">{kbSaving ? "등록 중…" : "지식 등록"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 확정 대기 → 발송 미리보기 (내용·비용 확인 후 발송) */}
      {sendModal && (
        <div className="fixed inset-0 bg-[#00000080] z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => !sendSaving && setSendModal(null)}>
          <div className="bg-white w-full max-w-[500px] rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2E8F0]">
              <h2 className="text-[16px] font-extrabold text-[#1A202C]">{sendModal.kind === "venue" ? "만남장소 안내 발송" : "첫날 규칙 안내 발송"}</h2>
              <button onClick={() => setSendModal(null)} className="text-[#A0AEC0] hover:text-[#4A5568]"><X size={20} /></button>
            </div>
            <div className="p-6 flex flex-col gap-4">
              <div className="text-[12.5px] text-[#718096] leading-relaxed">
                <b className="text-[#4A5568]">{sendModal.p.name}</b>님({sendModal.p.phone})에게 <b className="text-[#E53E3E]">실제 문자</b>가 발송됩니다. 아래 내용과 예상 비용을 확인하세요.
              </div>
              {sendModal.kind === "venue" && (
                <div>
                  <label className="block text-[12px] font-bold text-[#4A5568] mb-1.5">근무 시작일 (매니저가 정함)</label>
                  <input type="date" value={venueDate} onChange={(e) => { const v = e.target.value; setVenueDate(v); if (v) void fetchPreview(sendModal.p, "venue", v); else setPreview(null); }} className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-[13.5px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                </div>
              )}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[12px] font-bold text-[#4A5568]">발송 내용 미리보기</label>
                  {preview && <span className="text-[11px] font-bold text-[#B7791F] bg-[#FFFBEB] border border-[#FAF089] rounded-md px-2 py-0.5">{preview.sms_type} · 약 {preview.cost_krw}원</span>}
                </div>
                <div className="w-full min-h-[120px] px-4 py-3 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl text-[13px] leading-relaxed whitespace-pre-line text-[#2D3748]">
                  {previewLoading ? "불러오는 중…" : preview ? preview.text : (sendModal.kind === "venue" && !venueDate ? "시작일을 선택하면 발송 내용이 표시됩니다." : "미리보기를 불러오지 못했어요.")}
                </div>
                <div className="text-[11px] text-[#A0AEC0] mt-1.5">* 비용은 SOLAPI 기준 대략치입니다(SMS 20원 / LMS 33원). 실제 청구는 발송 결과에 따릅니다.</div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#E2E8F0]">
              <button onClick={() => setSendModal(null)} disabled={sendSaving} className="px-4 py-2 rounded-lg text-[13.5px] font-bold text-[#4A5568] hover:bg-[#F1F4F8] disabled:opacity-50">취소</button>
              <button onClick={doSend} disabled={sendSaving || previewLoading || !preview} className="px-5 py-2 rounded-lg text-[13.5px] font-bold text-white bg-[#2B6CB0] hover:bg-[#2C5282] disabled:opacity-50">{sendSaving ? "발송 중…" : "발송"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
