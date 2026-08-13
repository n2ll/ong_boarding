"use client";

import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import { Bot, User, Send, AlertTriangle, MessageSquare, Loader2, Wand2, Check, X, Ban } from "lucide-react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Switch } from "./ui/switch";
import { useConfirm } from "./ConfirmDialog";

interface PendingDraft {
  id: string;
  draft_text: string | null;
  reasoning: string | null;
  status: string;
  missing_info: string | null;
}

interface ApiMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string | null;
  created_at: string;
  sent_by?: string | null;
  job_id?: number | null;
}

interface JobLabel {
  title: string;
  branch: string | null;
}

/** 재컨택 맥락 이벤트(pool_events) — 스레드에 인라인 시스템 칩으로 병합 표시 */
interface PoolEvent {
  id: number;
  event_type: string;
  job_id: number | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

/** 이벤트 → 시스템 칩 라벨. 관심클릭은 공고명(jobsMap 재사용, 없으면 #N)·바로가능 표기. */
function poolEventLabel(ev: PoolEvent, jobsMap: Record<number, JobLabel>): string {
  const meta = (ev.meta ?? {}) as { immediate?: unknown; to?: unknown };
  switch (ev.event_type) {
    case "ping_sent":
      return "⚡ 다시 연락 문자 발송";
    case "link_view":
      return "👀 맞춤 공고 링크 열람";
    case "interest_click": {
      const title = ev.job_id != null ? jobsMap[ev.job_id]?.title?.trim() : undefined;
      const name = title || (ev.job_id != null ? `공고 #${ev.job_id}` : "공고");
      const immediate = meta.immediate === true || meta.immediate === "true";
      return `⭐ '${name}' 관심 클릭${immediate ? " · 바로 가능" : ""}`;
    }
    case "availability_set":
      return typeof meta.to === "string" && meta.to ? `🕐 가용성 → ${meta.to}` : "🕐 가용성 변경";
    case "opt_out_set":
      return "🚫 수신거부 등록";
    default:
      return ev.event_type;
  }
}

/** 공고 라벨 칩에 쓸 짧은 텍스트 — 지점명 우선, 없으면 제목 앞부분. */
function jobChipLabel(j: JobLabel): string {
  if (j.branch && j.branch.trim()) return j.branch.trim();
  const t = (j.title ?? "").trim();
  return t.length > 14 ? t.slice(0, 14) + "…" : t || "공고";
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function fmtDateLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return "";
  }
}

/** 일자 구분선 라벨 — 오늘/어제는 상대 라벨, 그 외는 날짜 전체. */
function fmtDateDivider(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (diffDays === 0) return "오늘";
    if (diffDays === 1) return "어제";
    return fmtDateLabel(iso);
  } catch {
    return fmtDateLabel(iso);
  }
}

// 코파일럿 초안 판정 마커 — reasoning 앞에 붙는다(lib/agent/kill-switch.ts COPILOT_DRAFT_MARKER와 동일 문자열).
const COPILOT_MARKER = "[코파일럿]";

function getByteLength(str: string) {
  let b = 0;
  for (let i = 0; i < str.length; i++) {
    const c = escape(str.charAt(i));
    if (c.length === 1) b++;
    else if (c.indexOf("%u") !== -1) b += 2;
    else if (c.indexOf("%") !== -1) b += c.length / 3;
  }
  return b;
}

interface ConversationThreadProps {
  applicantId: number;
  applicantName: string;
  phone: string | null;
  /** 공고별 대화 분리 — 지정 시 해당 공고 컨텍스트의 메시지/단계만 표시 */
  jobId?: number | null;
  /** 전역 킬스위치 상태 — true면 AI 배지 문구를 바꾸고 수동 발송 차단을 해제 */
  globalKill?: boolean;
  /** 전역 코파일럿(초안만) 모드 — true면 AI가 발송하지 않으므로 수동 발송을 열고 배지 문구를 바꾼다 */
  copilotMode?: boolean;
  /** 수신거부 시각(sms_opt_out_at) — 있으면 헤더에 빨간 배지 표시 */
  smsOptOutAt?: string | null;
  /** 발송·상태변경 후 부모(목록 등) 갱신용 */
  onChanged?: () => void;
  /** 폴링 주기(ms). 0이면 폴링 안 함 */
  pollMs?: number;
  /** 헤더(상태배지·AI토글) 표시 여부 — 패널 안에 임베드할 땐 끌 수 있음 */
  showHeader?: boolean;
  className?: string;
}

// 매니저가 인계 건에 자주 쓰는 답변 스니펫 — 클릭 시 입력창에 삽입(검토 후 발송).
// 실제 매니저 수동 응답(반복 패턴)을 인계 카테고리에 맞춰 정리한 것.
// 치환자: #{이름} · #{공고명} · #{지점} · #{맞춤링크} — bulk-send의 #{...} 문법과 통일.
// 삽입 시 치환값이 없으면 토큰을 그대로 남기고 노랑 토스트로 경고한다(무단 제거 금지).
// ⚠️ 확정 뉘앙스 금지: "확정/배정 완료"처럼 근무가 확정됐다는 의미를 주는 문구는 두지 않는다.
const QUICK_TEMPLATES: { label: string; text: string }[] = [
  { label: "확인 후 안내", text: `#{이름}님, 문의 주신 부분은 담당 매니저가 확인 후 정확히 안내드릴게요!` },
  { label: "통화 연결", text: `#{이름}님, 안녕하세요. 옹보딩입니다. 통화 가능하신 시간을 알려주시면 담당자가 연락드리겠습니다.` },
  { label: "순차 연락", text: `#{이름}님, 확인 감사합니다! 담당 매니저가 순차적으로 연락드릴 예정이에요. 조금만 기다려 주세요.` },
  { label: "대기 안내", text: `#{이름}님, 현재 지원이 많아 즉시 배정이 어려운 상황이에요. 자리가 생기면 가장 먼저 연락드리겠습니다!` },
  { label: "관심 대기 안내", text: `[옹고잉] #{이름}님, '#{공고명}' 관심 감사합니다. 현재 순차적으로 안내드리고 있어요. 자리가 정리되는 대로 먼저 연락드릴게요!` },
  { label: "맞춤 공고 링크 안내", text: `#{이름}님, 지금 모집 중인 공고를 본인 전용 페이지에서 모아 보실 수 있어요. 편하실 때 확인해보세요!\n#{맞춤링크}` },
  { label: "스크리닝 확인", text: `#{이름}님, 몇 가지만 확인 부탁드릴게요!\n- 배송에 쓰실 자차를 보유하고 계신가요?\n- 본인 명의로 정산 받으시는 데 문제 없으실까요?\n- 공휴일에도 업무 가능하실까요?` },
  { label: "온보딩 절차", text: `#{이름}님, 업무 진행을 위한 안내드릴게요. 영상 교육 수료 후 회신 부탁드립니다.\n1. 배민 커넥트 앱 설치 후 가입\n2. 가입 시 안전보건교육 영상(2시간) 시청\n3. 교육 수료 후 앱 아이디 회신` },
  { label: "서류 요청", text: `#{이름}님, 지원 감사합니다. 진행을 위해 신분증 사진 1장 회신 부탁드립니다.` },
  { label: "감사 인사", text: `#{이름}님, 문의 주셔서 감사합니다. 추가로 궁금하신 점 있으면 편하게 말씀해주세요.` },
];

/**
 * 지원자별 SMS 대화 스레드(말풍선 + AI 초안 검수 + 입력창)를 self-contained하게 렌더.
 * LiveConsole·지원자 상세 패널 등 어디서든 applicantId만 주면 재사용 가능.
 */
export function ConversationThread({
  applicantId,
  applicantName,
  phone,
  jobId = null,
  globalKill = false,
  copilotMode = false,
  smsOptOutAt = null,
  onChanged,
  pollMs = 12000,
  showHeader = true,
  className = "",
}: ConversationThreadProps) {
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [events, setEvents] = useState<PoolEvent[]>([]);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [jobsMap, setJobsMap] = useState<Record<number, JobLabel>>({});
  const [agentStage, setAgentStage] = useState<string | null>(null);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sending, setSending] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  const [optOutBusy, setOptOutBusy] = useState(false);
  const confirm = useConfirm();
  const scrollRef = useRef<HTMLDivElement>(null);

  const jobQS = jobId != null ? `?job_id=${jobId}` : "";

  const loadMessages = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoadingMsgs(true);
      try {
        const res = await fetch(`/api/admin/messages/${applicantId}${jobQS}`);
        const json = await res.json();
        setMessages((json.messages ?? []) as ApiMessage[]);
        setEvents((json.events ?? []) as PoolEvent[]);
        setAccessToken((json.access_token as string | null) ?? null);
        setJobsMap((json.jobs ?? {}) as Record<number, JobLabel>);
        setAgentStage(json.agent_stage ?? null);
      } catch {
        if (!opts?.silent) toast.error("대화 내역을 불러오지 못했어요");
      } finally {
        if (!opts?.silent) setLoadingMsgs(false);
      }
    },
    [applicantId, jobQS]
  );

  const loadDraft = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/drafts/pending?applicant_id=${applicantId}`);
      const json = await res.json();
      const d = (json.data as PendingDraft | null) ?? null;
      setPendingDraft(d);
      setDraftText(d?.draft_text ?? "");
    } catch {
      setPendingDraft(null);
      setDraftText("");
    }
  }, [applicantId]);

  useEffect(() => {
    loadMessages();
    loadDraft();
  }, [loadMessages, loadDraft]);

  // 가벼운 폴링 — 화면을 보고 있는 동안 새 메시지/초안 자동 반영
  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => {
      loadMessages({ silent: true });
      loadDraft();
    }, pollMs);
    return () => clearInterval(t);
  }, [pollMs, loadMessages, loadDraft]);

  // 스크롤: 최초 로드는 '마지막 지원자(inbound) 메시지' 위치로 — 무엇에 답해야 하는지 바로 보이게.
  // inbound가 없으면 기존처럼 맨 아래. 이후 새 메시지 도착 시에는 맨 아래로.
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true;
      const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");
      const target = lastInbound ? el.querySelector<HTMLElement>(`[data-msg-id="${lastInbound.id}"]`) : null;
      if (target) {
        el.scrollTop = Math.max(0, target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 24);
        return;
      }
    }
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  const isPaused = agentStage === "paused";
  const hasActiveFlow = agentStage != null && agentStage !== "abort";
  const isAiEnabled = hasActiveFlow && !isPaused;
  // 전역 킬스위치·코파일럿 중에는 AI가 직접 발송하지 않으므로 수동 발송을 열어 교착을 방지한다.
  const canSend = !isAiEnabled || globalKill || copilotMode;

  // 멀티-잡: 이 스레드가 2개 이상 공고에 걸쳐 있으면 말풍선마다 공고 라벨 칩 표시(섞임 방지).
  // 특정 공고로 필터된 스레드(jobId 지정)나 단일 공고면 칩을 숨겨 노이즈를 줄인다.
  const showJobChips = jobId == null && Object.keys(jobsMap).length > 1;

  // 재컨택 이벤트 노이즈 억제 — 같은 타입(+같은 공고) 연속은 마지막 것만 남긴다
  // (link_view 반복 열람 등). 서버가 created_at 오름차순으로 내려준다.
  const dedupedEvents: PoolEvent[] = [];
  for (const ev of events) {
    const last = dedupedEvents[dedupedEvents.length - 1];
    if (last && last.event_type === ev.event_type && last.job_id === ev.job_id) {
      dedupedEvents[dedupedEvents.length - 1] = ev;
    } else {
      dedupedEvents.push(ev);
    }
  }

  // 말풍선 + 재컨택 이벤트 칩을 created_at 시간순으로 병합한 타임라인.
  // 매니저가 "이 '네'가 무엇에 대한 답인지"를 스레드 안에서 바로 대조할 수 있게 한다.
  type TimelineItem = { kind: "msg"; msg: ApiMessage } | { kind: "event"; ev: PoolEvent };
  const timeline: TimelineItem[] = [
    ...messages.map((msg): TimelineItem => ({ kind: "msg", msg })),
    ...dedupedEvents.map((ev): TimelineItem => ({ kind: "event", ev })),
  ].sort((a, b) => {
    const at = new Date(a.kind === "msg" ? a.msg.created_at : a.ev.created_at).getTime();
    const bt = new Date(b.kind === "msg" ? b.msg.created_at : b.ev.created_at).getTime();
    return at - bt; // 안정 정렬 — 동시각이면 메시지가 이벤트보다 먼저
  });

  // 빠른 템플릿 변수 치환 — #{이름}/#{공고명}/#{지점}/#{맞춤링크}(bulk-send 문법 통일).
  // 값이 없는 변수는 토큰을 그대로 남기고 목록으로 돌려줘 경고 토스트의 근거로 쓴다.
  const fillTemplateVars = (text: string): { filled: string; unresolved: string[] } => {
    const job = jobId != null ? jobsMap[jobId] : undefined;
    const values: Record<string, string | null> = {
      "#{이름}": (applicantName || "지원자").trim() || "지원자",
      "#{공고명}": job?.title?.trim() || null,
      "#{지점}": job?.branch?.trim() || null,
      "#{맞춤링크}": accessToken ? `${window.location.origin}/p/${accessToken}` : null,
    };
    let filled = text;
    const unresolved: string[] = [];
    for (const [token, value] of Object.entries(values)) {
      if (!filled.includes(token)) continue;
      if (value) filled = filled.split(token).join(value);
      else unresolved.push(token);
    }
    return { filled, unresolved };
  };

  const insertTemplate = (text: string) => {
    const { filled, unresolved } = fillTemplateVars(text);
    setInputValue((prev) => (prev.trim() ? prev + "\n" + filled : filled));
    if (unresolved.length > 0) {
      toast.warning(`'${unresolved.join("', '")}' 치환값이 없어요 — 확인 후 발송하세요`);
    }
  };

  // AI 끄기는 지원자가 무응답으로 방치될 수 있어 확인을 받는다 — 단 작은 토글을 잘못 누르는 경우만 대상.
  // [개입] 버튼은 매니저가 지금 직접 답하려고 명시적으로 누르는 것이라(즉시 개입이 설계 의도) 확인을 건너뛴다.
  const handleToggleAi = async (checked: boolean, opts?: { skipConfirm?: boolean }) => {
    if (!hasActiveFlow) {
      toast.info("이 지원자는 활성 AI 대화 흐름이 없어요. 매니저가 직접 응대합니다.");
      return;
    }
    if (!checked && !opts?.skipConfirm) {
      if (!(await confirm({
        title: `${applicantName}님 AI를 끌까요?`,
        description: "이 대화의 자동 응대가 멈추고 매니저가 직접 답해야 해요. 잊으면 지원자가 답을 못 받습니다. 다시 켜면 재개돼요.",
        confirmText: "AI 끄기",
      }))) return;
    }
    const endpoint = checked ? "/api/admin/agent/resume" : "/api/admin/agent/pause";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: applicantId, job_id: jobId ?? undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "상태 변경에 실패했어요");
        return;
      }
      setAgentStage(checked ? json.restored_stage ?? "exploration" : "paused");
      toast.success(
        checked
          ? `${applicantName}님 AI 자동 응대를 재개했어요.`
          : `${applicantName}님 AI를 끄고 매니저 수동 응대로 전환했어요.`
      );
      onChanged?.();
    } catch {
      toast.error("상태 변경에 실패했어요");
    }
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || sending) return;
    if (!phone) {
      toast.error("이 지원자는 전화번호가 없어 발송할 수 없어요");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/admin/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: applicantId, phone, body: inputValue.trim(), sent_by: "관리자", job_id: jobId ?? undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "문자 발송에 실패했어요");
        return;
      }
      toast.success("문자(SMS)를 발송했어요");
      setInputValue("");
      await loadMessages({ silent: true });
      // **서버가 실제로 멈춘 것만 배지에 반영한다.** 낙관 갱신은 거짓 표시를 만든다 —
      // 관심만 누른 공고(진행 단계 없음) 탭에서 답장하면 멈출 후보가 아예 없는데도 '수동 응대'로 바뀌어,
      // 매니저는 AI가 멈춘 줄 알고 손을 떼지만 다른 공고의 AI는 계속 돌아 이중 응답이 된다.
      if (json.paused_job_id != null) {
        setAgentStage("paused");
      } else if (json.paused_skipped === "ambiguous") {
        toast.warning("진행 중 공고가 여러 개라 AI 자동 응대는 멈추지 않았어요 — 필요하면 공고를 고르고 'AI 끄기'를 눌러 주세요.");
      } else {
        toast.info("이 공고에는 멈출 AI 응대가 없어 그대로예요 — 다른 공고에서 AI가 돌고 있다면 그 탭에서 꺼 주세요.");
      }
      onChanged?.();
    } catch {
      toast.error("문자 발송에 실패했어요");
    } finally {
      setSending(false);
    }
  };

  // §6.5 원자 동작: 발송 성공 후 인계 큐의 'AI 재개'와 동일한 재개 API를 순차 호출.
  const handleSendAndResume = async () => {
    if (!inputValue.trim() || sending) return;
    if (!phone) {
      toast.error("이 지원자는 전화번호가 없어 발송할 수 없어요");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/admin/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: applicantId, phone, body: inputValue.trim(), sent_by: "관리자", job_id: jobId ?? undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "문자 발송에 실패했어요");
        return;
      }
      setInputValue("");
      // 발송은 이미 성공한 시점 — 재개의 네트워크 예외가 바깥 catch의 "발송 실패"로 오표시되지 않게 분리
      try {
        const resumeRes = await fetch("/api/admin/agent/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ applicant_id: applicantId, job_id: jobId ?? undefined }),
        });
        const resumeJson = await resumeRes.json().catch(() => ({}));
        if (!resumeRes.ok) {
          toast.error(resumeJson.error || "발송은 됐지만 AI 재개에 실패했어요. AI 토글로 다시 시도해주세요.");
        } else {
          setAgentStage(resumeJson.restored_stage ?? "exploration");
          toast.success("문자를 보내고 AI 응대를 재개했어요.");
        }
      } catch {
        toast.error("발송은 됐지만 AI 재개에 실패했어요. AI 토글로 다시 시도해주세요.");
      }
      await loadMessages({ silent: true });
      onChanged?.();
    } catch {
      toast.error("문자 발송에 실패했어요");
    } finally {
      setSending(false);
    }
  };

  const handleSendDraft = async () => {
    if (!pendingDraft || draftBusy) return;
    if (!phone) {
      toast.error("이 지원자는 전화번호가 없어 발송할 수 없어요");
      return;
    }
    const body = draftText.trim();
    if (!body) {
      toast.error("초안 내용이 비어 있어요. 직접 입력 후 발송해주세요.");
      return;
    }
    setDraftBusy(true);
    try {
      const res = await fetch("/api/admin/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicant_id: applicantId,
          phone,
          body,
          sent_by: "관리자",
          job_id: jobId ?? undefined,
          draft_id: pendingDraft.id,
          draft_was_edited: body !== (pendingDraft.draft_text ?? ""),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "발송에 실패했어요");
        return;
      }
      toast.success("AI 초안을 검수해 발송했어요.");
      // 코파일럿 초안 승인은 서버가 pause 전이를 건너뛴다(초안 루프 유지) — UI 상태도 맞춘다.
      const wasCopilot = (pendingDraft.reasoning ?? "").startsWith(COPILOT_MARKER);
      setPendingDraft(null);
      setDraftText("");
      await loadMessages({ silent: true });
      if (!wasCopilot) setAgentStage("paused");
      onChanged?.();
    } catch {
      toast.error("발송에 실패했어요");
    } finally {
      setDraftBusy(false);
    }
  };

  // 수신거부 수동 등록/해제 — sms_opt_out_at 토글. 확인 모달 후 PATCH, 부모 갱신으로 배지 반영.
  const handleToggleOptOut = async () => {
    if (optOutBusy) return;
    const registering = !smsOptOutAt;
    const ok = await confirm(
      registering
        ? {
            title: `${applicantName}님을 수신거부로 등록할까요?`,
            description: "캠페인 발송이 영구 중단됩니다. 수동 문자는 계속 보낼 수 있어요.",
            confirmText: "수신거부 등록",
            destructive: true,
          }
        : {
            title: `${applicantName}님 수신거부를 해제할까요?`,
            description: "다시 캠페인 발송 대상에 포함됩니다.",
            confirmText: "해제",
          }
    );
    if (!ok) return;
    setOptOutBusy(true);
    try {
      const res = await fetch(`/api/admin/applicants/${applicantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sms_opt_out_at: registering ? new Date().toISOString() : null }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error || "수신거부 변경에 실패했어요");
        return;
      }
      toast.success(registering ? "수신거부로 등록했어요. 캠페인 발송에서 제외됩니다." : "수신거부를 해제했어요.");
      onChanged?.();
    } catch {
      toast.error("수신거부 변경에 실패했어요");
    } finally {
      setOptOutBusy(false);
    }
  };

  const handleIgnoreDraft = async () => {
    if (!pendingDraft || draftBusy) return;
    setDraftBusy(true);
    try {
      const res = await fetch(`/api/admin/drafts/${pendingDraft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ignored" }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error || "처리에 실패했어요");
        return;
      }
      toast.info("AI 초안을 무시했어요.");
      setPendingDraft(null);
      setDraftText("");
    } catch {
      toast.error("처리에 실패했어요");
    } finally {
      setDraftBusy(false);
    }
  };

  const currentBytes = getByteLength(inputValue);
  const isLMS = currentBytes > 90;

  const isCopilotDraft = (pendingDraft?.reasoning ?? "").startsWith(COPILOT_MARKER);
  const draftReasoningDisplay = isCopilotDraft
    ? (pendingDraft?.reasoning ?? "").slice(COPILOT_MARKER.length).trimStart()
    : pendingDraft?.reasoning ?? null;

  return (
    <div className={`flex flex-col bg-muted min-w-0 min-h-0 ${className}`}>
      {/* 상태 헤더 + AI 토글 */}
      {showHeader && (
        <div className="shrink-0 bg-white border-b border-border-strong px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {!hasActiveFlow ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-gray-700 bg-muted px-3 py-1.5 rounded-lg border border-gray-300"><MessageSquare size={14} /> 수동 문자 모드</span>
            ) : isPaused ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-yellow-600 bg-yellow-100 px-3 py-1.5 rounded-lg border border-yellow-300"><User size={14} /> 수동 개입 중</span>
            ) : globalKill ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-yellow-700 bg-yellow-50 px-3 py-1.5 rounded-lg border border-yellow-200"><AlertTriangle size={14} /> AI 전역 중지됨 — 수동 응대 가능</span>
            ) : copilotMode ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-copilot-strong bg-copilot-soft px-3 py-1.5 rounded-lg border border-copilot/30"><Wand2 size={14} /> 코파일럿 — AI 초안만, 발송은 매니저 승인</span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-bold text-info bg-info-soft px-3 py-1.5 rounded-lg border border-info/25"><Bot size={14} /> 옹봇 자동 응대 중</span>
            )}
            {smsOptOutAt ? (
              <>
                <span className="flex items-center gap-1.5 text-xs font-bold text-error-strong bg-error-soft px-3 py-1.5 rounded-lg border border-error/30"><Ban size={14} /> 수신거부 — 캠페인 발송 제외</span>
                <button
                  onClick={handleToggleOptOut}
                  disabled={optOutBusy}
                  title="수신거부 해제 — 다시 캠페인 발송 대상에 포함"
                  className="text-[11.5px] font-bold text-gray-700 bg-background hover:bg-muted border border-border-strong px-2.5 py-1 rounded-full transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
                >
                  해제
                </button>
              </>
            ) : (
              <button
                onClick={handleToggleOptOut}
                disabled={optOutBusy}
                title="수신거부 수동 등록 — 캠페인 발송이 영구 중단됩니다"
                className="flex items-center gap-1 text-[11.5px] font-bold text-error-strong bg-white hover:bg-error-soft border border-error/30 px-2.5 py-1 rounded-full transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
              >
                <Ban size={12} /> 수신거부 등록
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-2.5 px-3 py-1.5 rounded-xl border transition-colors ${isAiEnabled ? "bg-success-soft border-success-soft" : "bg-error-soft border-error/30"}`}>
              <span className={`text-[12px] font-extrabold ${isAiEnabled ? "text-success-strong" : "text-error-strong"}`}>{isAiEnabled ? "AI ON" : "AI OFF"}</span>
              <Switch checked={isAiEnabled} onCheckedChange={handleToggleAi} disabled={!hasActiveFlow} className="data-[state=checked]:bg-success data-[state=unchecked]:bg-error" />
            </div>
            {isAiEnabled && (
              <button onClick={() => handleToggleAi(false, { skipConfirm: true })} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background bg-foreground text-white px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5"><User size={15} /> 개입</button>
            )}
          </div>
        </div>
      )}

      {/* 메시지 영역 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 flex flex-col gap-5 min-h-0">
        {loadingMsgs && <div className="text-[13px] text-gray-400 text-center py-8">대화 내역 불러오는 중…</div>}
        {!loadingMsgs && timeline.length === 0 && <div className="text-[13px] text-gray-400 text-center py-8">아직 주고받은 메시지가 없어요</div>}

        {timeline.map((item, idx) => {
          const createdAt = item.kind === "msg" ? item.msg.created_at : item.ev.created_at;
          // 일자 구분선 — 이전 항목(메시지·이벤트)과 날짜가 바뀌는 지점마다 삽입 (첫 항목 포함)
          const prevItem = idx > 0 ? timeline[idx - 1] : null;
          const prevAt = prevItem ? (prevItem.kind === "msg" ? prevItem.msg.created_at : prevItem.ev.created_at) : null;
          const showDateDivider = !prevAt || new Date(prevAt).toDateString() !== new Date(createdAt).toDateString();

          // 재컨택 이벤트 — 말풍선 사이 중앙 정렬 시스템 칩(일자 구분선과 같은 톤, 더 작게)
          if (item.kind === "event") {
            const ev = item.ev;
            return (
              <Fragment key={`ev-${ev.id}`}>
                {showDateDivider && (
                  <div className="flex justify-center mb-2"><div className="bg-gray-200 text-muted-foreground text-[11px] font-bold px-3 py-1 rounded-full">{fmtDateDivider(createdAt)}</div></div>
                )}
                <div className="flex justify-center -my-2">
                  <div className="bg-gray-200 text-muted-foreground text-[10.5px] font-semibold px-2.5 py-0.5 rounded-full" title={`${fmtDateLabel(createdAt)} ${fmtTime(createdAt)}`}>
                    {poolEventLabel(ev, jobsMap)} · {fmtTime(createdAt)}
                  </div>
                </div>
              </Fragment>
            );
          }

          const msg = item.msg;
          const isInbound = msg.direction === "inbound";
          const sender = isInbound ? "user" : "ai";
          return (
            <Fragment key={msg.id}>
            {showDateDivider && (
              <div className="flex justify-center mb-2"><div className="bg-gray-200 text-muted-foreground text-[11px] font-bold px-3 py-1 rounded-full">{fmtDateDivider(msg.created_at)}</div></div>
            )}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(idx * 0.02, 0.2) }} data-msg-id={msg.id} className={`flex gap-3 ${sender === "user" ? "justify-end" : "justify-start"}`}>
              {sender === "ai" && <div className="w-9 h-9 rounded-full bg-brand-yellow flex items-center justify-center shrink-0 border border-yellow-500"><Bot size={18} className="text-foreground" /></div>}
              <div className={`flex flex-col gap-1 max-w-[78%] ${sender === "user" ? "items-end" : "items-start"}`}>
                {sender === "ai" && <span className="text-[11.5px] font-bold text-muted-foreground ml-1">{msg.sent_by === "관리자" ? "매니저" : "옹봇 에이전트"}</span>}
                {showJobChips && msg.job_id != null && jobsMap[msg.job_id] && (
                  <span className="text-[10.5px] font-bold text-info bg-info-soft border border-info/25 px-2 py-0.5 rounded-full mx-1" title={jobsMap[msg.job_id]!.title}>
                    {jobChipLabel(jobsMap[msg.job_id]!)}
                  </span>
                )}
                <div className={`p-3.5 rounded-2xl text-[14px] leading-relaxed shadow-sm whitespace-pre-wrap ${sender === "user" ? "bg-foreground text-white rounded-tr-sm" : "bg-white border border-border-strong text-gray-800 rounded-tl-sm"}`}>
                  {msg.body}
                </div>
                <span className="text-[11px] text-gray-400 mx-1">{fmtTime(msg.created_at)}</span>
              </div>
            </motion.div>
            </Fragment>
          );
        })}
      </div>

      {/* AI 초안 검수 카드 */}
      {pendingDraft && (
        <div className="px-5 pt-4 bg-white border-t border-border-strong">
          <div className="border border-copilot bg-copilot-soft rounded-2xl p-4">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2 text-[13px] font-extrabold text-copilot-strong">
                <Wand2 size={16} /> {isCopilotDraft ? "⚡ 코파일럿 초안" : "옹봇이 제안한 답변 초안"}
                {pendingDraft.status === "need_info" && (
                  <span className="text-[11px] font-bold bg-yellow-50 text-warning-strong border border-warning/35 px-2 py-0.5 rounded-full">정보 부족 · 매니저 확인</span>
                )}
              </div>
              <span className="text-[11px] font-bold text-copilot">검수 후 발송됩니다</span>
            </div>
            {pendingDraft.status === "need_info" && pendingDraft.missing_info && (
              <div className="mb-2.5 text-[12px] text-warning-strong bg-white border border-warning/35 rounded-lg px-3 py-2 leading-relaxed">
                <b>부족한 정보:</b> {pendingDraft.missing_info}
              </div>
            )}
            <textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              placeholder={pendingDraft.status === "need_info" ? "AI가 답변을 보류했어요. 매니저가 직접 답변을 입력해 발송하세요." : "초안을 수정한 뒤 발송할 수 있어요."}
              rows={3}
              className="w-full bg-white border border-border-strong rounded-xl p-3 text-[14px] leading-relaxed text-gray-800 focus:outline-none focus:border-copilot focus:ring-1 focus:ring-copilot resize-none"
            />
            {draftReasoningDisplay && (
              <div className="mt-2 text-[11.5px] text-muted-foreground leading-relaxed">
                <b className="text-copilot">판단 근거:</b> {draftReasoningDisplay}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 mt-3">
              <button onClick={handleIgnoreDraft} disabled={draftBusy} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-4 py-2 rounded-xl text-[13px] font-bold text-muted-foreground hover:bg-white border border-border-strong disabled:opacity-50 flex items-center gap-1.5"><X size={15} /> 무시</button>
              <button onClick={handleSendDraft} disabled={draftBusy} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-5 py-2 rounded-xl text-[13px] font-bold text-white bg-copilot-strong hover:bg-copilot-strong disabled:opacity-50 flex items-center gap-1.5">
                {draftBusy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} 검수 후 발송
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 입력 영역 */}
      <div className="p-5 bg-white border-t border-border-strong shrink-0">
        {canSend ? (
          <>
          <div className="flex gap-1.5 flex-wrap mb-2.5">
            {QUICK_TEMPLATES.map((t) => (
              <button
                key={t.label}
                onClick={() => insertTemplate(t.text)}
                className="text-[11.5px] font-bold text-gray-700 bg-background hover:bg-muted border border-border-strong px-2.5 py-1 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
                title={t.text}
              >
                + {t.label}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-3">
            <div className={`flex-1 border-2 rounded-2xl overflow-hidden bg-background focus-within:bg-white ${isLMS ? "border-error" : "border-border-strong focus-within:border-brand-yellow"}`}>
              <textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSendMessage(); } }}
                placeholder="지원자에게 발송될 문자를 입력하세요..."
                className="w-full bg-transparent outline-none p-3.5 text-[14px] min-h-[56px]"
                rows={2}
              />
              <div className={`flex justify-between items-center px-3.5 pb-2.5 pt-1.5 border-t ${isLMS ? "border-error/30 bg-error-soft" : "border-muted"}`}>
                <div className="flex gap-2 items-center text-[12px] font-bold">
                  <span className={isLMS ? "text-error" : "text-info"}>{isLMS ? "LMS" : "SMS"}</span>
                  <span className="text-muted-foreground">{currentBytes} bytes</span>
                </div>
                <span className="text-[11px] text-gray-400">⌘+Enter 발송</span>
              </div>
            </div>
            <button onClick={handleSendMessage} disabled={sending} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-[54px] h-[54px] rounded-[14px] bg-brand-yellow hover:bg-yellow-500 disabled:opacity-50 flex items-center justify-center shrink-0">{sending ? <Loader2 size={22} className="text-foreground animate-spin" /> : <Send size={22} className="text-foreground" />}</button>
            {isPaused && (
              <button
                onClick={handleSendAndResume}
                disabled={sending}
                title="발송 성공 후 AI 자동 응대를 즉시 재개합니다"
                className="h-[54px] px-3 rounded-[14px] text-[12px] font-bold bg-info-soft text-info-strong border border-info/25 hover:bg-info/25 disabled:opacity-50 shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
              >
                보내고
                <br />
                AI 재개
              </button>
            )}
          </div>
          </>
        ) : (
          <div className="flex items-center justify-between bg-background border border-border-strong rounded-xl p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-info-soft flex items-center justify-center border border-info/25"><Bot size={20} className="text-info" /></div>
              <div>
                <div className="text-[14px] font-bold text-foreground">AI가 대화형 스크리닝을 진행 중입니다.</div>
                <div className="text-[12px] text-muted-foreground mt-0.5">[개입]을 누르면 자동 응대가 중지됩니다.</div>
              </div>
            </div>
            <AlertTriangle size={18} className="text-gray-400" />
          </div>
        )}
      </div>
    </div>
  );
}
