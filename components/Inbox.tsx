import { useState } from "react";
import useSWR from "swr";
import { Inbox as InboxIcon, RefreshCw, Phone, Check, Ban, Loader2, MessageSquareWarning, ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";

interface PendingMessage {
  id: string;
  applicant_phone: string;
  body: string;
  created_at: string;
  sent_by: string | null;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60000);
  if (diffMin < 1) return "방금 전";
  if (diffMin < 60) return `${diffMin}분 전`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}시간 전`;
  return d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" }) +
    " " + d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

interface ActiveJob { id: number; title: string; recruit_mode: string | null; status: string | null; closes_at: string | null; }

export function Inbox() {
  const { data, isLoading, isValidating, mutate } = useSWR<{ data?: PendingMessage[] }>("/api/admin/inbox/pending");
  const messages = data?.data ?? [];
  const loading = isLoading && messages.length === 0;
  const [busyId, setBusyId] = useState<string | null>(null);
  const confirm = useConfirm();

  // 등록 대상 공고 — 진행 중 실공고(시스템 더미·마감 제외). '지원자로 등록' 시 라인 선택용.
  const { data: jobsData } = useSWR<{ data?: ActiveJob[] }>("/api/admin/jobs?status=active");
  const activeJobs = (jobsData?.data ?? []).filter(
    (j) => typeof j.title === "string" && !j.title.startsWith("__") &&
      !(j.closes_at && new Date(j.closes_at).getTime() <= Date.now())
  );

  // 분류 되돌리기 — 기타·옹매니징(단순 마킹)만. 목록에 다시 띄워 재분류할 수 있게 한다.
  // 지원자 등록(배민·공고)은 지원자·후보·초안이 생겨 마킹 해제로 원복되지 않으므로 서버가 거부한다.
  const undoClassify = async (msg: PendingMessage) => {
    try {
      const res = await fetch(`/api/admin/inbox/${msg.id}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "undo" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "되돌리기에 실패했어요");
        return;
      }
      toast.success("분류를 되돌렸어요.");
      // 서버가 pending으로 복구했으니 목록을 재검증해 카드를 되살린다.
      void mutate();
    } catch {
      toast.error("되돌리기에 실패했어요");
    }
  };

  const classify = async (
    msg: PendingMessage,
    action: "baemin" | "job" | "other" | "ongmanaging",
    opts?: { jobId?: number; jobLabel?: string }
  ) => {
    if (busyId) return;
    // 등록은 즉시, 첫 문자는 초안까지만 — 매니저가 대화에서 검수하고 직접 보낸다(자동 실발송 없음).
    if (action === "baemin") {
      if (!(await confirm({
        title: `${msg.applicant_phone} — 배민 커넥트로 등록할까요?`,
        description: "지원자로 등록하고 AI 첫 응답 초안을 만듭니다. 문자는 자동으로 나가지 않고, 실시간 응대에서 내용을 확인한 뒤 직접 보내요.",
        confirmText: "등록",
      }))) return;
    } else if (action === "job") {
      if (!(await confirm({
        title: `${msg.applicant_phone} — '${opts?.jobLabel ?? "선택 공고"}'로 등록할까요?`,
        description: "이 공고 지원자로 등록하고 라인에 맞는 AI 첫 응답 초안을 만듭니다. 문자는 자동으로 나가지 않고, 실시간 응대에서 내용을 확인한 뒤 직접 보내요.",
        confirmText: "등록",
      }))) return;
    } else if (action === "ongmanaging") {
      if (!(await confirm({
        title: "기존 계약자 문의로 분류할까요?",
        description: "옹고잉 재직자·기존 계약자 문의로 표시할까요? AI 응대 대상에서 제외돼요.",
        confirmText: "분류",
      }))) return;
    } else {
      if (!(await confirm({
        title: "기타로 분류할까요?",
        description: "응대 대상에서 제외 처리됩니다.",
      }))) return;
    }
    setBusyId(msg.id);
    try {
      const res = await fetch(`/api/admin/inbox/${msg.id}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "job" ? { action, job_id: opts?.jobId } : { action }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "분류에 실패했어요");
        return;
      }
      // 이미 분류된 문자(같은 번호의 형제 카드 등)는 서버가 아무 일도 하지 않는다 — 성공처럼 보이면
      // '방금 이 공고로 등록했다'는 오보가 되므로 구분해 알리고 목록을 재검증한다.
      if (json.noop) {
        toast.info("이 문자는 이미 처리된 건이에요. 목록을 새로 불러왔어요.");
        void mutate();
        return;
      }
      if (action === "baemin" || action === "job") {
        const where = action === "job" ? (opts?.jobLabel ?? "선택 공고") : "배민 커넥트";
        // 다음 행동을 반드시 지정한다(무응답 방치 방지). 초안과 인계는 함께 발생할 수 있으므로
        // 둘 다 알린다 — 초안만 알리면 'AI가 멈춰서 재개가 필요하다'는 사실이 묻힌다.
        const next = json.draft_created
          ? "AI 첫 응답 초안을 실시간 응대에서 확인하고 보내세요."
          : "AI 초안이 만들어지지 않았어요 — 실시간 응대에서 직접 답해주세요.";
        const handoff = json.handed_off
          ? " AI 자동 응대는 멈춤 상태예요(실시간 응대 › 사람 확인 필요) — 보낸 뒤 필요하면 AI를 재개하세요."
          : "";
        toast.success(`${where}로 등록했어요. ${next}${handoff}`, { duration: 10000 });
      } else if (action === "ongmanaging") {
        // 단순 마킹이라 되돌리기 가능(지원자 등록과 달리 생성물이 없다).
        toast.success("기존 계약자 문의로 분류했어요.", { action: { label: "실행취소", onClick: () => void undoClassify(msg) } });
      } else {
        toast.success("기타로 분류해 종결했어요.", { action: { label: "실행취소", onClick: () => void undoClassify(msg) } });
      }
      // 처리 완료 항목을 캐시에서 즉시 제거(낙관적). 재검증은 다음 진입/새로고침에서.
      // 지원자 등록(배민·공고)은 서버가 같은 번호의 대기 문자를 한꺼번에 처리하므로 번호 기준으로 제거한다
      // — id만 지우면 형제 문자가 '유령 카드'로 남아 재클릭 시 중복 등록·발송으로 이어졌다.
      // 기타·옹매니징은 서버가 대상 문자 1건만 마킹하므로 id 기준 유지(번호로 지우면 되살아나 불일치).
      const perPhone = action === "baemin" || action === "job";
      void mutate(
        (cur) => ({
          data: (cur?.data ?? []).filter((m) => (perPhone ? m.applicant_phone !== msg.applicant_phone : m.id !== msg.id)),
        }),
        { revalidate: false }
      );
    } catch {
      toast.error("분류에 실패했어요");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-brand-yellow rounded-2xl flex items-center justify-center shadow-sm">
            <InboxIcon size={24} className="text-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold text-foreground tracking-tight mb-1">분류 대기 문자함</h1>
            <p className="text-[14px] text-muted-foreground">어느 지원자의 문자인지 자동으로 연결하지 못한 수신 문자입니다. 아래 버튼으로 직접 분류해주세요.</p>
          </div>
        </div>
        <button
          onClick={() => mutate()}
          className="flex items-center gap-2 bg-white border border-border-strong text-gray-700 hover:bg-background px-4 py-2.5 rounded-xl font-bold transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
        >
          <RefreshCw size={16} className={isValidating ? "animate-spin" : ""} /> 새로고침
        </button>
      </div>

      <div className="flex items-center gap-2 mb-5 text-[13px] text-muted-foreground">
        <MessageSquareWarning size={16} className="text-yellow-600" />
        처리 대기 <b className="text-foreground">{messages.length}</b>건
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-[13px] text-gray-400 py-10">
          <Loader2 size={16} className="animate-spin" /> 불러오는 중…
        </div>
      )}

      {!loading && messages.length === 0 && (
        <div className="flex flex-col items-center justify-center text-center py-20 text-gray-400">
          <div className="w-16 h-16 rounded-full bg-success-soft flex items-center justify-center mb-4">
            <Check size={30} className="text-success" />
          </div>
          <div className="text-[15px] font-bold text-gray-700 mb-1">모두 처리했어요</div>
          <div className="text-[13px]">분류가 필요한 문자가 새로 오면 여기에 표시됩니다.</div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {messages.map((msg) => {
          const busy = busyId === msg.id;
          return (
            <div key={msg.id} className="bg-white border border-border-strong rounded-2xl p-5 shadow-sm flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[13px] font-bold text-gray-700">
                  <Phone size={13} className="text-gray-400" /> {msg.applicant_phone}
                </div>
                <span className="text-[12px] text-gray-400">{formatTime(msg.created_at)}</span>
              </div>
              <div className="text-[14px] leading-relaxed text-gray-800 bg-background border border-muted rounded-xl px-4 py-3 whitespace-pre-wrap">
                {msg.body}
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => classify(msg, "other")}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-bold text-muted-foreground hover:bg-background border border-border-strong disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
                >
                  <Ban size={15} /> 기타로 분류
                </button>
                <button
                  onClick={() => classify(msg, "ongmanaging")}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-bold text-muted-foreground hover:bg-background border border-border-strong disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
                >
                  <ArrowRightLeft size={15} /> 기존 계약자 문의
                </button>
                {/* 지원자로 등록 — 어느 라인/공고로 보낼지 선택(도시락 등 실공고 or 배민 커넥트 자동). */}
                <div className="relative flex items-center">
                  {busy && <Loader2 size={15} className="animate-spin text-gray-400 mr-2" />}
                  <select
                    disabled={busy}
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "baemin") classify(msg, "baemin");
                      else if (v) {
                        const j = activeJobs.find((x) => String(x.id) === v);
                        classify(msg, "job", { jobId: Number(v), jobLabel: j?.title });
                      }
                    }}
                    className="appearance-none px-5 py-2 pr-9 rounded-xl text-[13px] font-bold text-white bg-foreground hover:bg-gray-800 disabled:opacity-60 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
                    title="이 문의를 지원자로 등록할 공고(라인)를 선택하세요"
                  >
                    <option value="">＋ 지원자로 등록…</option>
                    {activeJobs.length > 0 && (
                      <optgroup label="공고로 등록">
                        {activeJobs.map((j) => (
                          <option key={j.id} value={String(j.id)}>{j.title.replace(/\s*\([^)]*원\)\s*$/, "")}</option>
                        ))}
                      </optgroup>
                    )}
                    <option value="baemin">배민 커넥트(자동 분류)</option>
                  </select>
                  <Check size={14} className="absolute right-3 text-brand-yellow pointer-events-none" />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
