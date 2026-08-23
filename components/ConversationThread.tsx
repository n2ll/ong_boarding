"use client";

import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import { Bot, User, Send, AlertTriangle, MessageSquare, Loader2, Wand2, Check, X, Ban, ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Switch } from "./ui/switch";
import { useConfirm } from "./ConfirmDialog";
import {
  detectManualOutboundSafetyViolation,
  PRECONFIRMATION_ONBOARDING_TEMPLATE,
  PRIVACY_SAFE_ID_DOCUMENT_TEMPLATE,
} from "@/lib/agent/outbound-safety";
import {
  manualMessageClientResolution,
  manualMessagePauseOutcome,
  nextManualMessageAttempt,
} from "@/lib/manual-message-send";
import {
  clearDraftMessageComposerSnapshot,
  manualMessageComposerSnapshotMatches,
  manualMessageComposerResolution,
  manualMessageComposerStorageKey,
  readDraftMessageComposerSnapshot,
  readManualMessageComposerSnapshot,
  resolveDraftMessageComposerSnapshot,
  resolveManualMessageComposerSnapshot,
  writeDraftMessageComposerSnapshot,
  writeManualMessageComposerSnapshot,
  type ManualMessageComposerSnapshot,
} from "@/lib/manual-message-composer-storage";
import {
  conversationAgentPresentation,
  conversationMessagesView,
} from "@/lib/conversation-thread-view";
import { shouldAdvanceLiveReplyAfterSend } from "@/lib/admin/live-reply-navigation";
import { pendingDraftMatchesScope } from "@/lib/admin/pending-draft-scope";

interface PendingDraft {
  id: string;
  job_id: number | null;
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
  status?: string | null;
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
    case "handoff_resolved": {
      // 인계 큐 '처리 완료' — 매니저가 전화·문자로 직접 해결한 기록. 통화 결과가 타임라인에 남아
      // 다음 사람이 같은 사람에게 다시 걸거나 아무도 안 거는 일이 없게 한다.
      const m = (ev.meta ?? {}) as { outcome?: unknown; note?: unknown };
      const outcome = m.outcome === "call" ? "통화로 해결" : m.outcome === "sms" ? "문자로 해결" : "종결";
      const note = typeof m.note === "string" && m.note.trim() ? ` — ${m.note.trim()}` : "";
      return `☎️ 매니저 처리 완료 (${outcome})${note}`;
    }
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
  /** jobId가 없을 때 미지정 초안만 조회할지, 전체 공고의 최신 초안을 조회할지 구분 */
  draftScope?: "all" | "unscoped";
  /** 전역 킬스위치 상태 — true면 AI 배지 문구를 바꾸고 수동 발송 차단을 해제 */
  globalKill?: boolean;
  /** 전역 코파일럿(초안만) 모드 — true면 AI가 발송하지 않으므로 수동 발송을 열고 배지 문구를 바꾼다 */
  copilotMode?: boolean;
  /** 수신거부 시각(sms_opt_out_at) — 있으면 헤더에 빨간 배지 표시 */
  smsOptOutAt?: string | null;
  /** 발송·상태변경 후 부모(목록 등) 갱신용 */
  onChanged?: () => void;
  /** 완전히 기록된 발송 뒤 부모의 다음 답장 대상으로 이동 */
  onQueueItemCompleted?: (applicantId: number, contextKey: string) => void;
  /** 공고 미지정 초안을 닫은 뒤 job_id NULL 작성창에 머물지 않도록 부모가 안전한 공고로 전환 */
  onUnscopedDraftResolved?: () => void;
  /** 현재 항목 뒤에 처리할 답장이 더 있는지 — 없으면 완료 액션으로 표시 */
  hasNextQueueItem?: boolean;
  /** 발송 시작 시점의 탭·검색 범위. 완료 시 범위가 달라졌으면 자동 이동하지 않는다. */
  queueContextKey?: string;
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
  { label: "사전 준비(선택)", text: PRECONFIRMATION_ONBOARDING_TEMPLATE },
  { label: "신분증 보호 안내", text: PRIVACY_SAFE_ID_DOCUMENT_TEMPLATE },
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
  draftScope = "all",
  globalKill = false,
  copilotMode = false,
  smsOptOutAt = null,
  onChanged,
  onQueueItemCompleted,
  onUnscopedDraftResolved,
  hasNextQueueItem = false,
  queueContextKey = "",
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
  const [messagesLoadErrorIdentity, setMessagesLoadErrorIdentity] = useState<{ key: string; revision: number } | null>(null);
  const [loadedScopeIdentity, setLoadedScopeIdentity] = useState<{ key: string; revision: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [manualComposer, setManualComposer] = useState<ManualMessageComposerSnapshot & {
    scopeKey: string;
    ready: boolean;
  }>({ scopeKey: "", body: "", attempt: null, ready: false });
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const [draftComposer, setDraftComposer] = useState<ManualMessageComposerSnapshot & {
    draftId: string | null;
    ready: boolean;
  }>({ draftId: null, body: "", attempt: null, ready: false });
  const [draftBusy, setDraftBusy] = useState(false);
  const [optOutBusy, setOptOutBusy] = useState(false);
  const confirm = useConfirm();
  const scrollRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const messageLoadSequenceRef = useRef(0);
  const loadedScopeIdentityRef = useRef<{ key: string; revision: number } | null>(null);

  const threadScopeKey = `${applicantId}:${jobId ?? "all"}:${draftScope}`;
  const threadScopeRef = useRef(threadScopeKey);
  threadScopeRef.current = threadScopeKey;
  const threadScopeIdentityRef = useRef({ key: threadScopeKey, revision: 0 });
  if (threadScopeIdentityRef.current.key !== threadScopeKey) {
    threadScopeIdentityRef.current = {
      key: threadScopeKey,
      revision: threadScopeIdentityRef.current.revision + 1,
    };
  }
  const threadScopeRevision = threadScopeIdentityRef.current.revision;
  const messagesLoadError = messagesLoadErrorIdentity?.key === threadScopeKey
    && messagesLoadErrorIdentity.revision === threadScopeRevision;
  const isCurrentThreadScope = (scopeKey: string, revision: number) => (
    mountedRef.current
    && threadScopeIdentityRef.current.key === scopeKey
    && threadScopeIdentityRef.current.revision === revision
  );
  const manualComposerKey = manualMessageComposerStorageKey(applicantId, jobId);
  const manualComposerReady = manualComposer.ready && manualComposer.scopeKey === manualComposerKey;
  const inputValue = manualComposerReady ? manualComposer.body : "";

  // 공고 탭 전환 직후 이전 요청의 초안이 잠시 남더라도 다른 공고 카드로 노출·처리하지 않는다.
  const scopedPendingDraft = loadedScopeIdentity?.key === threadScopeKey
    && loadedScopeIdentity.revision === threadScopeRevision
    && pendingDraft
    && pendingDraftMatchesScope(pendingDraft.job_id, jobId, draftScope)
    ? pendingDraft
    : null;
  const activeDraftId = scopedPendingDraft?.id ?? null;
  const draftComposerReady = draftComposer.ready && draftComposer.draftId === activeDraftId;
  const draftText = draftComposerReady ? draftComposer.body : "";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const snapshot = readManualMessageComposerSnapshot(applicantId, jobId);
    setManualComposer({
      scopeKey: manualComposerKey,
      body: snapshot?.body ?? "",
      attempt: snapshot?.attempt ?? null,
      ready: true,
    });
  }, [applicantId, jobId, manualComposerKey]);

  useEffect(() => {
    if (!scopedPendingDraft) {
      setDraftComposer({ draftId: null, body: "", attempt: null, ready: true });
      return;
    }
    const snapshot = readDraftMessageComposerSnapshot(scopedPendingDraft.id);
    setDraftComposer({
      draftId: scopedPendingDraft.id,
      body: snapshot?.body ?? scopedPendingDraft.draft_text ?? "",
      attempt: snapshot?.attempt ?? null,
      ready: true,
    });
  }, [scopedPendingDraft?.id]);

  const jobQS = jobId != null
    ? `?job_id=${jobId}`
    : draftScope === "unscoped"
      ? "?draft_scope=unscoped"
      : "";

  const loadMessages = useCallback(
    async (opts?: { silent?: boolean }) => {
      const requestedScopeKey = threadScopeKey;
      const requestedScopeRevision = threadScopeIdentityRef.current.revision;
      const requestSequence = ++messageLoadSequenceRef.current;
      if (!opts?.silent) {
        setLoadingMsgs(true);
        setMessagesLoadErrorIdentity(null);
      }
      try {
        const res = await fetch(`/api/admin/messages/${applicantId}${jobQS}`);
        const json = await res.json();
        if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "message fetch failed");
        if (
          !mountedRef.current
          || threadScopeRef.current !== requestedScopeKey
          || threadScopeIdentityRef.current.revision !== requestedScopeRevision
          || messageLoadSequenceRef.current !== requestSequence
        ) return;
        setMessages((json.messages ?? []) as ApiMessage[]);
        setEvents((json.events ?? []) as PoolEvent[]);
        setAccessToken((json.access_token as string | null) ?? null);
        setJobsMap((json.jobs ?? {}) as Record<number, JobLabel>);
        setAgentStage(json.agent_stage ?? null);

        // 미처리 초안은 이 응답에 이미 실려 온다(route.ts의 `draft`).
        // 예전엔 이걸 두고 /api/admin/drafts/pending을 따로 한 번 더 불렀다 — 같은 테이블·같은
        // 조건·같은 정렬의 완전히 같은 조회였고, 12초 폴링이라 요청이 두 배로 나가고 있었다.
        const d = (json.draft as PendingDraft | null) ?? null;
        setPendingDraft(d);
        const loadedIdentity = { key: requestedScopeKey, revision: requestedScopeRevision };
        loadedScopeIdentityRef.current = loadedIdentity;
        setLoadedScopeIdentity(loadedIdentity);
        setMessagesLoadErrorIdentity(null);
      } catch {
        if (
          !mountedRef.current
          || threadScopeRef.current !== requestedScopeKey
          || threadScopeIdentityRef.current.revision !== requestedScopeRevision
          || messageLoadSequenceRef.current !== requestSequence
        ) return;
        if (
          loadedScopeIdentityRef.current?.key !== requestedScopeKey
          || loadedScopeIdentityRef.current.revision !== requestedScopeRevision
        ) {
          setMessagesLoadErrorIdentity({ key: requestedScopeKey, revision: requestedScopeRevision });
          if (!opts?.silent) toast.error("대화 내역을 불러오지 못했어요");
        }
      } finally {
        if (
          mountedRef.current
          && threadScopeRef.current === requestedScopeKey
          && threadScopeIdentityRef.current.revision === requestedScopeRevision
          && messageLoadSequenceRef.current === requestSequence
        ) setLoadingMsgs(false);
      }
    },
    [applicantId, jobQS, threadScopeKey]
  );

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // 가벼운 폴링 — 화면을 보고 있는 동안 새 메시지/초안 자동 반영
  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => {
      loadMessages({ silent: true });
    }, pollMs);
    return () => clearInterval(t);
  }, [pollMs, loadMessages]);

  const scopeReady = loadedScopeIdentity?.key === threadScopeKey
    && loadedScopeIdentity.revision === threadScopeRevision;
  const currentMessages = scopeReady ? messages : [];
  const currentEvents = scopeReady ? events : [];
  const currentJobsMap = scopeReady ? jobsMap : {};
  const agentPresentation = conversationAgentPresentation({
    scopeReady,
    draftScope,
    agentStage,
  });

  // 스크롤: 최초 로드는 '마지막 지원자(inbound) 메시지' 위치로 — 무엇에 답해야 하는지 바로 보이게.
  // inbound가 없으면 기존처럼 맨 아래. 이후 새 메시지 도착 시에는 맨 아래로.
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    didInitialScrollRef.current = false;
  }, [threadScopeKey]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || currentMessages.length === 0) return;
    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true;
      const lastInbound = [...currentMessages].reverse().find((m) => m.direction === "inbound");
      const target = lastInbound ? el.querySelector<HTMLElement>(`[data-msg-id="${lastInbound.id}"]`) : null;
      if (target) {
        el.scrollTop = Math.max(0, target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 24);
        return;
      }
    }
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMessages]);

  const isPaused = agentPresentation.kind === "paused";
  const hasActiveFlow = agentPresentation.hasActiveFlow;
  const isAiEnabled = agentPresentation.isAiEnabled;
  // 전역 킬스위치·코파일럿 중에는 AI가 직접 발송하지 않으므로 수동 발송을 열어 교착을 방지한다.
  const canSend = scopeReady && (!isAiEnabled || globalKill || copilotMode);

  // 멀티-잡: 이 스레드가 2개 이상 공고에 걸쳐 있으면 말풍선마다 공고 라벨 칩 표시(섞임 방지).
  // 특정 공고로 필터된 스레드(jobId 지정)나 단일 공고면 칩을 숨겨 노이즈를 줄인다.
  const showJobChips = jobId == null && Object.keys(currentJobsMap).length > 1;

  // 재컨택 이벤트 노이즈 억제 — 같은 타입(+같은 공고) 연속은 마지막 것만 남긴다
  // (link_view 반복 열람 등). 서버가 created_at 오름차순으로 내려준다.
  const dedupedEvents: PoolEvent[] = [];
  for (const ev of currentEvents) {
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
    ...currentMessages.map((msg): TimelineItem => ({ kind: "msg", msg })),
    ...dedupedEvents.map((ev): TimelineItem => ({ kind: "event", ev })),
  ].sort((a, b) => {
    const at = new Date(a.kind === "msg" ? a.msg.created_at : a.ev.created_at).getTime();
    const bt = new Date(b.kind === "msg" ? b.msg.created_at : b.ev.created_at).getTime();
    return at - bt; // 안정 정렬 — 동시각이면 메시지가 이벤트보다 먼저
  });
  const messagesView = conversationMessagesView({
    loading: loadingMsgs || (!scopeReady && !messagesLoadError),
    error: messagesLoadError,
    itemCount: timeline.length,
  });

  // 빠른 템플릿 변수 치환 — #{이름}/#{공고명}/#{지점}/#{맞춤링크}(bulk-send 문법 통일).
  // 값이 없는 변수는 토큰을 그대로 남기고 목록으로 돌려줘 경고 토스트의 근거로 쓴다.
  const fillTemplateVars = (text: string): { filled: string; unresolved: string[] } => {
    const job = jobId != null ? currentJobsMap[jobId] : undefined;
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

  const setInputValue = (next: string | ((previous: string) => string)) => {
    if (!manualComposerReady || sending) return;
    const body = typeof next === "function" ? next(manualComposer.body) : next;
    const snapshot = { body, attempt: manualComposer.attempt };
    writeManualMessageComposerSnapshot(applicantId, jobId, snapshot);
    setManualComposer({ ...snapshot, scopeKey: manualComposerKey, ready: true });
  };

  const setDraftText = (body: string) => {
    if (!activeDraftId || !draftComposerReady || draftBusy) return;
    const snapshot = { body, attempt: draftComposer.attempt };
    writeDraftMessageComposerSnapshot(activeDraftId, snapshot);
    setDraftComposer({ ...snapshot, draftId: activeDraftId, ready: true });
  };

  const applyManualComposerResolution = (
    origin: {
      scopeKey: string;
      scopeRevision: number;
      composerKey: string;
      applicantId: number;
      jobId: number | null;
      snapshot: ManualMessageComposerSnapshot;
    },
    resolution: ReturnType<typeof manualMessageClientResolution>,
  ) => {
    const transition = manualMessageComposerResolution(origin.snapshot, resolution);
    resolveManualMessageComposerSnapshot(
      origin.applicantId,
      origin.jobId,
      origin.snapshot,
      resolution,
    );
    if (!isCurrentThreadScope(origin.scopeKey, origin.scopeRevision)) return;
    setManualComposer((previous) => previous.scopeKey === origin.composerKey
      && manualMessageComposerSnapshotMatches(previous, origin.snapshot)
      ? { ...transition.visible, scopeKey: origin.composerKey, ready: true }
      : previous);
  };

  const applyDraftComposerResolution = (
    origin: {
      scopeKey: string;
      scopeRevision: number;
      draftId: string;
      snapshot: ManualMessageComposerSnapshot;
    },
    resolution: ReturnType<typeof manualMessageClientResolution>,
  ) => {
    const transition = manualMessageComposerResolution(origin.snapshot, resolution);
    resolveDraftMessageComposerSnapshot(
      origin.draftId,
      origin.snapshot,
      resolution,
    );
    if (!isCurrentThreadScope(origin.scopeKey, origin.scopeRevision) || activeDraftId !== origin.draftId) return;
    setDraftComposer((previous) => previous.draftId === origin.draftId
      && manualMessageComposerSnapshotMatches(previous, origin.snapshot)
      ? { ...transition.visible, draftId: origin.draftId, ready: true }
      : previous);
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
    const originScopeKey = threadScopeKey;
    const originScopeRevision = threadScopeRevision;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: applicantId, job_id: jobId ?? undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (mountedRef.current) toast.error(json.error || "상태 변경에 실패했어요");
        return;
      }
      if (isCurrentThreadScope(originScopeKey, originScopeRevision)) {
        setAgentStage(checked ? json.restored_stage ?? "exploration" : "paused");
      }
      if (mountedRef.current) {
        toast.success(
          checked
            ? `${applicantName}님 AI 자동 응대를 재개했어요.`
            : `${applicantName}님 AI를 끄고 매니저 수동 응대로 전환했어요.`
        );
        onChanged?.();
      }
    } catch {
      if (mountedRef.current) toast.error("상태 변경에 실패했어요");
    }
  };

  const handleSendMessage = async (advanceAfterSend = false) => {
    if (!manualComposerReady || !inputValue.trim() || sending) return;
    if (!phone) {
      toast.error("이 지원자는 전화번호가 없어 발송할 수 없어요");
      return;
    }
    if (detectManualOutboundSafetyViolation(inputValue.trim())) {
      toast.error("신분증 사진은 문자로 요청할 수 없어요. '신분증 보호 안내' 문구를 사용해주세요.");
      return;
    }
    const body = inputValue.trim();
    const attempt = nextManualMessageAttempt(
      manualComposer.attempt,
      { applicantId, phone, body, jobId, sentBy: "관리자", draftId: null, draftWasEdited: false },
      () => crypto.randomUUID()
    );
    const snapshot = { body, attempt };
    const origin = {
      scopeKey: threadScopeKey,
      scopeRevision: threadScopeRevision,
      composerKey: manualComposerKey,
      applicantId,
      jobId,
      snapshot,
    };
    if (!writeManualMessageComposerSnapshot(applicantId, jobId, snapshot)) {
      toast.error("중복 발송 방지 정보를 저장하지 못해 문자를 보내지 않았어요. 브라우저 저장 공간을 확인한 뒤 새로고침해주세요.");
      return;
    }
    setManualComposer({ ...snapshot, scopeKey: manualComposerKey, ready: true });
    setSending(true);
    try {
      const res = await fetch("/api/admin/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: applicantId, phone, body, sent_by: "관리자", job_id: jobId ?? undefined, idempotency_key: attempt.key }),
      });
      const json = await res.json().catch(() => ({}));
      const resolution = manualMessageClientResolution(json, res.ok);
      applyManualComposerResolution(origin, resolution);
      if (!mountedRef.current) return;
      if (!resolution.continueAfterSend) {
        if (resolution.kind === "unknown") {
          toast.warning(json.error || "발송 결과를 확인할 수 없어 중복 발송을 막았습니다. 같은 문자를 다시 보내지 말고 대화 내역을 확인해주세요.");
          await loadMessages({ silent: true });
        } else {
          toast.error(json.error || "문자 발송에 실패했어요");
        }
        return;
      }
      if (typeof json.warning === "string") {
        toast.warning(json.warning);
      } else if (resolution.kind === "sent_unrecorded") {
        toast.warning("문자는 발송됐지만 기록 상태를 확정하지 못했어요. 같은 문자를 다시 보내지 말고 대화 내역을 확인해주세요.");
      } else if (json.deduplicated) {
        toast.success("이미 처리된 발송을 확인했어요. 문자를 중복 발송하지 않았습니다.");
      } else {
        toast.success("문자(SMS)를 발송했어요");
      }
      await loadMessages({ silent: true });
      // **서버가 실제로 멈춘 것만 배지에 반영한다.** 낙관 갱신은 거짓 표시를 만든다 —
      // 관심만 누른 공고(진행 단계 없음) 탭에서 답장하면 멈출 후보가 아예 없는데도 '수동 응대'로 바뀌어,
      // 매니저는 AI가 멈춘 줄 알고 손을 떼지만 다른 공고의 AI는 계속 돌아 이중 응답이 된다.
      const pauseOutcome = manualMessagePauseOutcome(json);
      if (pauseOutcome.kind === "paused" && isCurrentThreadScope(origin.scopeKey, origin.scopeRevision)) {
        setAgentStage("paused");
      } else if (pauseOutcome.kind === "ambiguous") {
        toast.warning("진행 중 공고가 여러 개라 AI 자동 응대는 멈추지 않았어요 — 필요하면 공고를 고르고 'AI 끄기'를 눌러 주세요.");
      } else if (pauseOutcome.kind === "changed") {
        toast.warning("발송 요청 뒤 AI 상태가 바뀌어 자동 응대를 다시 끄지 않았어요. 현재 AI 토글 상태를 확인해주세요.");
      } else if (pauseOutcome.kind === "none") {
        toast.info("이 공고에는 멈출 AI 응대가 없어 그대로예요 — 다른 공고에서 AI가 돌고 있다면 그 탭에서 꺼 주세요.");
      }
      onChanged?.();
      if (isCurrentThreadScope(origin.scopeKey, origin.scopeRevision) && shouldAdvanceLiveReplyAfterSend({
        requested: advanceAfterSend,
        resolutionKind: resolution.kind,
        resumeRequired: false,
        resumeSucceeded: false,
        pauseOutcomeKind: pauseOutcome.kind,
      })) {
        onQueueItemCompleted?.(applicantId, queueContextKey);
      }
    } catch {
      if (mountedRef.current) toast.error("서버 응답을 확인하지 못했어요. 같은 내용으로 다시 시도하면 중복 발송 없이 기존 상태를 확인합니다.");
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  // §6.5 원자 동작: 발송 성공 후 인계 큐의 'AI 재개'와 동일한 재개 API를 순차 호출.
  const handleSendAndResume = async (advanceAfterSend = false) => {
    if (!manualComposerReady || !inputValue.trim() || sending) return;
    if (!phone) {
      toast.error("이 지원자는 전화번호가 없어 발송할 수 없어요");
      return;
    }
    if (detectManualOutboundSafetyViolation(inputValue.trim())) {
      toast.error("신분증 사진은 문자로 요청할 수 없어요. '신분증 보호 안내' 문구를 사용해주세요.");
      return;
    }
    const body = inputValue.trim();
    const attempt = nextManualMessageAttempt(
      manualComposer.attempt,
      { applicantId, phone, body, jobId, sentBy: "관리자", draftId: null, draftWasEdited: false },
      () => crypto.randomUUID()
    );
    const snapshot = { body, attempt };
    const origin = {
      scopeKey: threadScopeKey,
      scopeRevision: threadScopeRevision,
      composerKey: manualComposerKey,
      applicantId,
      jobId,
      snapshot,
    };
    if (!writeManualMessageComposerSnapshot(applicantId, jobId, snapshot)) {
      toast.error("중복 발송 방지 정보를 저장하지 못해 문자를 보내지 않았어요. 브라우저 저장 공간을 확인한 뒤 새로고침해주세요.");
      return;
    }
    setManualComposer({ ...snapshot, scopeKey: manualComposerKey, ready: true });
    setSending(true);
    try {
      const res = await fetch("/api/admin/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: applicantId, phone, body, sent_by: "관리자", job_id: jobId ?? undefined, idempotency_key: attempt.key }),
      });
      const json = await res.json();
      const resolution = manualMessageClientResolution(json, res.ok);
      applyManualComposerResolution(origin, resolution);
      if (!resolution.continueAfterSend) {
        if (resolution.kind === "unknown") {
          if (mountedRef.current) {
            toast.warning(json.error || "발송 결과를 확인할 수 없어 AI를 재개하지 않았어요. 같은 문자를 다시 보내지 말고 대화 내역을 확인해주세요.");
            await loadMessages({ silent: true });
          }
        } else {
          if (mountedRef.current) toast.error(json.error || "문자 발송에 실패했어요");
        }
        return;
      }
      if (mountedRef.current && typeof json.warning === "string") {
        toast.warning(json.warning);
      } else if (mountedRef.current && resolution.kind === "sent_unrecorded") {
        toast.warning("문자는 발송됐지만 기록 상태를 확정하지 못했어요. AI 재개 결과도 별도로 확인해주세요.");
      }
      // 발송은 이미 성공한 시점 — 재개의 네트워크 예외가 바깥 catch의 "발송 실패"로 오표시되지 않게 분리
      let resumeSucceeded = false;
      try {
        const resumeRes = await fetch("/api/admin/agent/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ applicant_id: applicantId, job_id: jobId ?? undefined }),
        });
        const resumeJson = await resumeRes.json().catch(() => ({}));
        if (!resumeRes.ok) {
          if (mountedRef.current) toast.error(resumeJson.error || "발송은 됐지만 AI 재개에 실패했어요. AI 토글로 다시 시도해주세요.");
        } else {
          resumeSucceeded = true;
          if (isCurrentThreadScope(origin.scopeKey, origin.scopeRevision)) {
            setAgentStage(resumeJson.restored_stage ?? "exploration");
          }
          if (mountedRef.current) toast.success("문자를 보내고 AI 응대를 재개했어요.");
        }
      } catch {
        if (mountedRef.current) toast.error("발송은 됐지만 AI 재개에 실패했어요. AI 토글로 다시 시도해주세요.");
      }
      if (mountedRef.current) await loadMessages({ silent: true });
      if (mountedRef.current) onChanged?.();
      if (isCurrentThreadScope(origin.scopeKey, origin.scopeRevision) && shouldAdvanceLiveReplyAfterSend({
        requested: advanceAfterSend,
        resolutionKind: resolution.kind,
        resumeRequired: true,
        resumeSucceeded,
        pauseOutcomeKind: "unknown",
      })) {
        onQueueItemCompleted?.(applicantId, queueContextKey);
      }
    } catch {
      if (mountedRef.current) toast.error("서버 응답을 확인하지 못했어요. 같은 내용으로 다시 시도하면 중복 발송 없이 기존 상태를 확인합니다.");
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  const handleSendDraft = async (advanceAfterSend = false) => {
    if (!scopedPendingDraft || !draftComposerReady || draftBusy) return;
    if (!phone) {
      toast.error("이 지원자는 전화번호가 없어 발송할 수 없어요");
      return;
    }
    const body = draftText.trim();
    if (!body) {
      toast.error("초안 내용이 비어 있어요. 직접 입력 후 발송해주세요.");
      return;
    }
    if (detectManualOutboundSafetyViolation(body)) {
      toast.error("신분증 사진은 문자로 요청할 수 없어요. 안전한 제출 방법 안내로 수정해주세요.");
      return;
    }
    const draftWasEdited = body !== (scopedPendingDraft.draft_text ?? "");
    const draftJobId = jobId ?? scopedPendingDraft.job_id;
    const attempt = nextManualMessageAttempt(
      draftComposer.attempt,
      {
        applicantId,
        phone,
        body,
        jobId: draftJobId,
        sentBy: "관리자",
        draftId: scopedPendingDraft.id,
        draftWasEdited,
      },
      () => crypto.randomUUID()
    );
    const snapshot = { body, attempt };
    const origin = {
      scopeKey: threadScopeKey,
      scopeRevision: threadScopeRevision,
      draftId: scopedPendingDraft.id,
      snapshot,
    };
    if (!writeDraftMessageComposerSnapshot(origin.draftId, snapshot)) {
      toast.error("중복 발송 방지 정보를 저장하지 못해 초안을 보내지 않았어요. 브라우저 저장 공간을 확인한 뒤 새로고침해주세요.");
      return;
    }
    setDraftComposer({ ...snapshot, draftId: origin.draftId, ready: true });
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
          job_id: draftJobId ?? undefined,
          draft_id: scopedPendingDraft.id,
          draft_was_edited: draftWasEdited,
          idempotency_key: attempt.key,
        }),
      });
      const json = await res.json().catch(() => ({}));
      const resolution = manualMessageClientResolution(json, res.ok);
      applyDraftComposerResolution(origin, resolution);
      if (!mountedRef.current) return;
      if (!resolution.continueAfterSend) {
        if (resolution.kind === "unknown") {
          toast.warning(json.error || "발송 결과를 확인할 수 없어 중복 발송을 막았습니다. 초안을 다시 보내지 말고 대화 내역을 확인해주세요.");
          await loadMessages({ silent: true });
        } else {
          toast.error(json.error || "발송에 실패했어요");
          if (res.status === 409) await loadMessages({ silent: true });
        }
        return;
      }
      if (typeof json.warning === "string") {
        toast.warning(json.warning);
      } else if (resolution.kind === "sent_unrecorded") {
        toast.warning("문자는 발송됐지만 기록 상태를 확정하지 못했어요. 같은 초안을 다시 보내지 마세요.");
      } else if (json.deduplicated) {
        toast.success("이미 처리된 초안 발송을 확인했어요. 중복 발송하지 않았습니다.");
      } else {
        toast.success("AI 초안을 검수해 발송했어요.");
      }
      const pauseOutcome = manualMessagePauseOutcome(json);
      if (isCurrentThreadScope(origin.scopeKey, origin.scopeRevision)) {
        setPendingDraft((current) => current?.id === origin.draftId ? null : current);
      }
      await loadMessages({ silent: true });
      if (pauseOutcome.kind === "paused" && isCurrentThreadScope(origin.scopeKey, origin.scopeRevision)) {
        setAgentStage("paused");
      } else if (pauseOutcome.kind === "ambiguous") {
        toast.warning("진행 중 공고가 여러 개라 AI 자동 응대는 멈추지 않았어요. 공고를 고른 뒤 AI 토글을 확인해주세요.");
      } else if (pauseOutcome.kind === "changed") {
        toast.warning("발송 요청 뒤 AI 상태가 바뀌어 자동 응대를 다시 끄지 않았어요. 현재 AI 토글 상태를 확인해주세요.");
      }
      onChanged?.();
      const shouldAdvance = isCurrentThreadScope(origin.scopeKey, origin.scopeRevision) && shouldAdvanceLiveReplyAfterSend({
        requested: advanceAfterSend,
        resolutionKind: resolution.kind,
        resumeRequired: false,
        resumeSucceeded: false,
        pauseOutcomeKind: pauseOutcome.kind,
      });
      if (shouldAdvance) {
        onQueueItemCompleted?.(applicantId, queueContextKey);
      } else if (
        resolution.kind === "sent"
        && scopedPendingDraft.job_id === null
        && isCurrentThreadScope(origin.scopeKey, origin.scopeRevision)
      ) {
        onUnscopedDraftResolved?.();
      }
    } catch {
      if (mountedRef.current) toast.error("서버 응답을 확인하지 못했어요. 같은 초안으로 다시 시도하면 중복 발송 없이 기존 상태를 확인합니다.");
    } finally {
      if (mountedRef.current) setDraftBusy(false);
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
    if (!scopedPendingDraft || draftBusy) return;
    const ignoredDraftId = scopedPendingDraft.id;
    const ignoredDraftJobId = scopedPendingDraft.job_id;
    const originScopeKey = threadScopeKey;
    const originScopeRevision = threadScopeRevision;
    setDraftBusy(true);
    try {
      const res = await fetch(`/api/admin/drafts/${ignoredDraftId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ignored",
          applicant_id: applicantId,
          job_id: scopedPendingDraft.job_id,
        }),
      });
      if (!res.ok) {
        if (!isCurrentThreadScope(originScopeKey, originScopeRevision)) return;
        const j = await res.json().catch(() => ({}));
        toast.error(j.error || "처리에 실패했어요");
        return;
      }
      clearDraftMessageComposerSnapshot(ignoredDraftId);
      if (!isCurrentThreadScope(originScopeKey, originScopeRevision)) return;
      toast.info("AI 초안을 무시했어요.");
      setDraftComposer((current) => current.draftId === ignoredDraftId
        ? { draftId: null, body: "", attempt: null, ready: true }
        : current);
      setPendingDraft((current) => current?.id === ignoredDraftId ? null : current);
      onChanged?.();
      if (ignoredDraftJobId === null) onUnscopedDraftResolved?.();
    } catch {
      if (isCurrentThreadScope(originScopeKey, originScopeRevision)) toast.error("처리에 실패했어요");
    } finally {
      if (mountedRef.current) setDraftBusy(false);
    }
  };

  const currentBytes = getByteLength(inputValue);
  const isLMS = currentBytes > 90;

  const isCopilotDraft = (scopedPendingDraft?.reasoning ?? "").startsWith(COPILOT_MARKER);
  const draftReasoningDisplay = isCopilotDraft
    ? (scopedPendingDraft?.reasoning ?? "").slice(COPILOT_MARKER.length).trimStart()
    : scopedPendingDraft?.reasoning ?? null;

  return (
    // 대화 스레드 = 불투명 캔버스(유리 금지) — 밴드·말풍선은 bg-muted 위 불투명 표면으로만 놓는다.
    <div className={`flex flex-col bg-muted min-w-0 min-h-0 ${className}`}>
      {/* 상태 헤더 + AI 토글 */}
      {showHeader && (
        <div className="shrink-0 bg-card border-b border-border-strong px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {!scopeReady && messagesLoadError ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-error bg-error-soft px-3 py-1.5 rounded-lg border border-error/30"><AlertTriangle size={14} /> 대화 상태를 불러오지 못함</span>
            ) : !scopeReady ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground bg-muted px-3 py-1.5 rounded-lg border border-border-strong"><Loader2 size={14} className="animate-spin" /> 대화 상태 불러오는 중</span>
            ) : agentPresentation.kind === "unscoped" ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-warning-strong bg-warning-soft px-3 py-1.5 rounded-lg border border-warning/30"><AlertTriangle size={14} /> 공고 미지정 초안 · 수동 검토</span>
            ) : !hasActiveFlow ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-gray-700 bg-muted px-3 py-1.5 rounded-lg border border-gray-300"><MessageSquare size={14} /> 수동 문자 모드</span>
            ) : isPaused ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-warning-strong bg-yellow-100 px-3 py-1.5 rounded-lg border border-yellow-300"><User size={14} /> 수동 개입 중</span>
            ) : globalKill ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-warning-strong bg-yellow-50 px-3 py-1.5 rounded-lg border border-yellow-200"><AlertTriangle size={14} /> AI 전역 중지됨 — 수동 응대 가능</span>
            ) : copilotMode ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-copilot-strong bg-copilot-soft px-3 py-1.5 rounded-lg border border-copilot/30"><Wand2 size={14} /> 코파일럿 — AI 초안만, 발송은 매니저 승인</span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-bold text-info-strong bg-info-soft px-3 py-1.5 rounded-lg border border-info/25"><Bot size={14} /> 옹봇 자동 응대 중</span>
            )}
            {smsOptOutAt ? (
              <>
                <span className="flex items-center gap-1.5 text-xs font-bold text-error-strong bg-error-soft px-3 py-1.5 rounded-lg border border-error/30"><Ban size={14} /> 수신거부 — 캠페인 발송 제외</span>
                <button
                  onClick={handleToggleOptOut}
                  disabled={optOutBusy}
                  title="수신거부 해제 — 다시 캠페인 발송 대상에 포함"
                  className="text-[12px] font-bold text-gray-700 bg-background hover:bg-muted border border-border-strong px-2.5 py-1 rounded-full transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  해제
                </button>
              </>
            ) : (
              <button
                onClick={handleToggleOptOut}
                disabled={optOutBusy}
                title="수신거부 수동 등록 — 캠페인 발송이 영구 중단됩니다"
                className="flex items-center gap-1 text-[12px] font-bold text-error-strong bg-card hover:bg-error-soft border border-error/30 px-2.5 py-1 rounded-full transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Ban size={12} /> 수신거부 등록
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {agentPresentation.kind === "unscoped" ? (
              <div role="status" className="max-w-[320px] rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[12px] font-semibold leading-4 text-warning-strong">
                {agentPresentation.notice}
              </div>
            ) : agentPresentation.showControls ? (
              <>
                <div className={`flex items-center gap-2.5 px-3 py-1.5 rounded-2xl border transition-colors ${isAiEnabled ? "bg-success-soft border-success-soft" : "bg-error-soft border-error/30"}`}>
                  <span className={`text-[12px] font-extrabold ${isAiEnabled ? "text-success-strong" : "text-error-strong"}`}>{isAiEnabled ? "AI ON" : "AI OFF"}</span>
                  <Switch
                    checked={isAiEnabled}
                    onCheckedChange={handleToggleAi}
                    disabled={!hasActiveFlow}
                    aria-label={isAiEnabled ? "AI 자동 응대 끄기" : "AI 자동 응대 켜기"}
                    className="data-[state=checked]:bg-success data-[state=unchecked]:bg-error"
                  />
                </div>
                {isAiEnabled && (
                  <button onClick={() => handleToggleAi(false, { skipConfirm: true })} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background bg-foreground text-white px-3.5 py-2 rounded-2xl text-xs font-bold flex items-center gap-1.5"><User size={15} /> 개입</button>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* 메시지 영역 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 flex flex-col gap-5 min-h-0">
        {messagesView === "loading" && <div className="text-[13px] text-muted-foreground text-center py-8">대화 내역 불러오는 중…</div>}
        {messagesView === "error" && (
          <div role="alert" className="mx-auto flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-error/30 bg-error-soft px-5 py-4 text-center">
            <div className="text-[13px] font-bold text-error-strong">대화 내역을 불러오지 못했어요.</div>
            <button
              type="button"
              onClick={() => void loadMessages()}
              className="min-h-10 rounded-xl border border-error/30 bg-card px-4 text-[12px] font-bold text-error-strong outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
            >
              다시 시도
            </button>
          </div>
        )}
        {messagesView === "empty" && <div className="text-[13px] text-muted-foreground text-center py-8">아직 주고받은 메시지가 없어요</div>}

        {messagesView === "ready" && timeline.map((item, idx) => {
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
                  <div className="flex justify-center mb-2"><div className="bg-gray-200 text-muted-foreground text-[12px] font-bold px-3 py-1 rounded-full">{fmtDateDivider(createdAt)}</div></div>
                )}
                <div className="flex justify-center -my-2">
                  <div className="bg-gray-200 text-muted-foreground text-[12px] font-semibold px-2.5 py-0.5 rounded-full" title={`${fmtDateLabel(createdAt)} ${fmtTime(createdAt)}`}>
                    {poolEventLabel(ev, currentJobsMap)} · {fmtTime(createdAt)}
                  </div>
                </div>
              </Fragment>
            );
          }

          const msg = item.msg;
          const isInbound = msg.direction === "inbound";
          const sender = isInbound ? "user" : "ai";
          const outboundFailed = !isInbound && msg.status === "failed";
          const outboundUncertain = !isInbound && (msg.status === "sending" || msg.status === "unknown");
          return (
            <Fragment key={msg.id}>
            {showDateDivider && (
              <div className="flex justify-center mb-2"><div className="bg-gray-200 text-muted-foreground text-[12px] font-bold px-3 py-1 rounded-full">{fmtDateDivider(msg.created_at)}</div></div>
            )}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(idx * 0.02, 0.2) }} data-msg-id={msg.id} className={`flex gap-3 ${sender === "user" ? "justify-end" : "justify-start"}`}>
              {sender === "ai" && <div className="w-9 h-9 rounded-full bg-brand-yellow flex items-center justify-center shrink-0 border border-yellow-500"><Bot size={18} className="text-foreground" /></div>}
              <div className={`flex flex-col gap-1 max-w-[78%] ${sender === "user" ? "items-end" : "items-start"}`}>
                {sender === "ai" && <span className="text-[12px] font-bold text-muted-foreground ml-1">{msg.sent_by === "관리자" ? "매니저" : "옹봇 에이전트"}</span>}
                {showJobChips && msg.job_id != null && currentJobsMap[msg.job_id] && (
                  <span className="text-[12px] font-bold text-info-strong bg-info-soft border border-info/25 px-2 py-0.5 rounded-full mx-1" title={currentJobsMap[msg.job_id]!.title}>
                    {jobChipLabel(currentJobsMap[msg.job_id]!)}
                  </span>
                )}
                <div className={`p-3.5 rounded-2xl text-[14px] leading-relaxed shadow-sm whitespace-pre-wrap ${sender === "user" ? "bg-foreground text-white rounded-tr-sm" : outboundFailed ? "bg-error-soft border border-error/30 text-error-strong rounded-tl-sm" : outboundUncertain ? "bg-warning-soft border border-warning/35 text-gray-800 rounded-tl-sm" : "bg-card border border-border-strong text-gray-800 rounded-tl-sm"}`}>
                  {msg.body}
                </div>
                <span className={`text-[12px] mx-1 ${outboundFailed ? "font-bold text-error-strong" : outboundUncertain ? "font-bold text-warning-strong" : "text-muted-foreground"}`}>
                  {outboundFailed ? "발송 실패 · " : outboundUncertain ? "발송 결과 확인 필요 · " : ""}{fmtTime(msg.created_at)}
                </span>
              </div>
            </motion.div>
            </Fragment>
          );
        })}
      </div>

      {/* AI 초안 검수 카드 */}
      {scopedPendingDraft && (
        <div className="px-5 pt-4 bg-card border-t border-border-strong">
          <div className="border border-copilot bg-copilot-soft rounded-2xl p-4">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2 text-[13px] font-extrabold text-copilot-strong">
                <Wand2 size={16} /> {isCopilotDraft ? "⚡ 코파일럿 초안" : "옹봇이 제안한 답변 초안"}
                {scopedPendingDraft.status === "need_info" && (
                  <span className="text-[12px] font-bold bg-yellow-50 text-warning-strong border border-warning/35 px-2 py-0.5 rounded-full">정보 부족 · 매니저 확인</span>
                )}
              </div>
              <span className="text-[12px] font-bold text-copilot-strong">검수 후 발송됩니다</span>
            </div>
            {scopedPendingDraft.status === "need_info" && scopedPendingDraft.missing_info && (
              <div className="mb-2.5 text-[12px] text-warning-strong bg-card border border-warning/35 rounded-lg px-3 py-2 leading-relaxed">
                <b>부족한 정보:</b> {scopedPendingDraft.missing_info}
              </div>
            )}
            <textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              disabled={draftBusy || !draftComposerReady}
              placeholder={scopedPendingDraft.status === "need_info" ? "AI가 답변을 보류했어요. 매니저가 직접 답변을 입력해 발송하세요." : "초안을 수정한 뒤 발송할 수 있어요."}
              rows={3}
              className="w-full bg-input-background border border-border-strong rounded-2xl p-3 text-[14px] leading-relaxed text-gray-800 focus:outline-none focus:border-copilot focus:ring-1 focus:ring-copilot resize-none"
            />
            {draftReasoningDisplay && (
              <div className="mt-2 text-[12px] text-muted-foreground leading-relaxed">
                <b className="text-copilot-strong">판단 근거:</b> {draftReasoningDisplay}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 mt-3">
              <button onClick={handleIgnoreDraft} disabled={draftBusy || !draftComposerReady} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-4 py-2 rounded-2xl text-[13px] font-bold text-muted-foreground hover:bg-card border border-border-strong disabled:opacity-50 flex items-center gap-1.5"><X size={15} /> 무시</button>
              {onQueueItemCompleted && (
                <button onClick={() => void handleSendDraft(false)} disabled={draftBusy || !draftComposerReady || !draftText.trim()} className="min-h-10 rounded-xl border border-border-strong bg-card px-3.5 text-[13px] font-bold text-gray-700 outline-none hover:bg-background disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring">
                  검수 발송만
                </button>
              )}
              <button onClick={() => void handleSendDraft(Boolean(onQueueItemCompleted))} disabled={draftBusy || !draftComposerReady || !draftText.trim()} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background min-h-10 px-4 rounded-xl text-[13px] font-bold text-white bg-copilot-strong hover:bg-copilot-strong disabled:opacity-50 flex items-center gap-1.5">
                {draftBusy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                {onQueueItemCompleted ? (hasNextQueueItem ? "검수 발송 후 다음" : "검수 발송하고 완료") : "검수 후 발송"}
                {onQueueItemCompleted && !draftBusy && <ArrowRight size={15} />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 입력 영역 */}
      <div className="p-5 bg-card border-t border-border-strong shrink-0">
        {!scopeReady && messagesLoadError ? (
          <div className="flex min-h-[54px] items-center justify-center gap-3 text-[13px] font-semibold text-error">
            <span>대화와 발송 상태를 불러오지 못했어요.</span>
            <button
              type="button"
              onClick={() => void loadMessages()}
              className="min-h-9 rounded-lg border border-error/30 bg-error-soft px-3 font-bold outline-none hover:bg-error/10 focus-visible:ring-2 focus-visible:ring-ring"
            >
              다시 시도
            </button>
          </div>
            ) : !scopeReady ? (
              <div className="flex min-h-[54px] items-center justify-center gap-2 text-[13px] font-semibold text-muted-foreground">
                <Loader2 size={16} className="animate-spin" /> 대화와 발송 상태를 확인하는 중…
              </div>
            ) : agentPresentation.kind === "unscoped" ? (
              <div role="status" className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning-strong">
                {scopedPendingDraft ? (
                  <><b>공고 미지정 초안만 처리할 수 있어요.</b> 위 초안 카드에서 내용을 검수해 발송하거나 무시하세요.</>
                ) : (
                  <><b>처리할 공고 미지정 초안을 찾지 못했어요.</b> 목록을 새로 확인하거나 공고 탭을 선택하세요.</>
                )}
              </div>
            ) : canSend ? (
          <>
          <div className="flex gap-1.5 flex-wrap mb-2.5">
            {QUICK_TEMPLATES.map((t) => (
              <button
                key={t.label}
                onClick={() => insertTemplate(t.text)}
                disabled={sending || !manualComposerReady}
                className="text-[12px] font-bold text-gray-700 bg-background hover:bg-muted border border-border-strong px-2.5 py-1 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={t.text}
              >
                + {t.label}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-3">
            <div className={`min-w-0 flex-1 border-2 rounded-2xl overflow-hidden bg-background focus-within:bg-input-background ${isLMS ? "border-error" : "border-border-strong focus-within:border-brand-yellow"}`}>
              <textarea
                aria-label="지원자에게 보낼 문자"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                disabled={sending || !manualComposerReady}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleSendMessage(false); } }}
                placeholder="지원자에게 발송될 문자를 입력하세요..."
                className="w-full bg-transparent outline-none p-3.5 text-[14px] min-h-[56px]"
                rows={2}
              />
              <div className={`flex justify-between items-center px-3.5 pb-2.5 pt-1.5 border-t ${isLMS ? "border-error/30 bg-error-soft" : "border-muted"}`}>
                <div className="flex gap-2 items-center text-[12px] font-bold">
                  <span className={isLMS ? "text-error" : "text-info"}>{isLMS ? "LMS" : "SMS"}</span>
                  <span className="text-muted-foreground">{currentBytes} bytes</span>
                </div>
                <span className="text-[12px] text-muted-foreground">Ctrl/⌘+Enter 발송</span>
              </div>
            </div>
            <button
              aria-label={onQueueItemCompleted ? "문자만 발송" : "문자 발송"}
              title={onQueueItemCompleted ? "현재 문자를 발송하고 이 대화에 머뭅니다" : undefined}
              onClick={() => void handleSendMessage(false)}
              disabled={sending || !inputValue.trim()}
              className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background h-[54px] min-w-[82px] rounded-lg border border-border-strong bg-card px-3.5 hover:bg-background disabled:opacity-50 flex items-center justify-center gap-1.5 shrink-0 text-[12px] font-bold text-gray-700"
            >
              {sending ? <Loader2 size={18} className="text-foreground animate-spin" /> : <><Send size={17} className="text-foreground" />{onQueueItemCompleted ? "발송만" : "발송"}</>}
            </button>
            {onQueueItemCompleted && !isPaused && (
              <button
                onClick={() => void handleSendMessage(true)}
                disabled={sending || !inputValue.trim()}
                title={hasNextQueueItem ? "발송이 완전히 기록된 뒤 다음 답장 대상으로 이동합니다" : "발송이 완전히 기록되면 답장 큐 처리를 마칩니다"}
                className="h-[54px] rounded-lg bg-foreground px-4 text-[13px] font-bold text-white shadow-action outline-none transition-colors hover:bg-gray-800 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {hasNextQueueItem ? <>보내고 다음 <ArrowRight size={16} className="ml-1 inline" /></> : "보내고 완료"}
              </button>
            )}
            {isPaused && (
              <button
                onClick={() => void handleSendAndResume(Boolean(onQueueItemCompleted))}
                disabled={sending || !inputValue.trim()}
                title={onQueueItemCompleted ? (hasNextQueueItem ? "발송과 AI 재개가 모두 성공한 뒤 다음 답장 대상으로 이동합니다" : "발송과 AI 재개가 모두 성공하면 답장 큐 처리를 마칩니다") : "발송 성공 후 AI 자동 응대를 즉시 재개합니다"}
                className={`h-[54px] px-3 rounded-lg text-[12px] font-bold disabled:opacity-50 shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${onQueueItemCompleted ? "bg-foreground text-white hover:bg-gray-800 shadow-action" : "bg-info-soft text-info-strong border border-info/25 hover:bg-info/25"}`}
              >
                {onQueueItemCompleted ? <>보내고 AI 재개<br />{hasNextQueueItem ? "후 다음" : "후 완료"}</> : <>보내고<br />AI 재개</>}
              </button>
            )}
          </div>
          </>
        ) : (
          <div className="flex items-center justify-between bg-background border border-border-strong rounded-2xl p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-info-soft flex items-center justify-center border border-info/25"><Bot size={20} className="text-info" /></div>
              <div>
                <div className="text-[14px] font-bold text-foreground">AI가 대화형 스크리닝을 진행 중입니다.</div>
                <div className="text-[12px] text-muted-foreground mt-0.5">[개입]을 누르면 자동 응대가 중지됩니다.</div>
              </div>
            </div>
            <AlertTriangle size={18} className="text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  );
}
