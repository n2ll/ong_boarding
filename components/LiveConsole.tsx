"use client";

// 워크벤치 콘솔 = 불투명 캔버스가 시스템(유리 금지) — 놓인 표면(패널 밴드·카드·행)은 bg-card로 수렴한다.

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Search, X, AlertTriangle, ArrowRight, Phone } from "lucide-react";
import { toast } from "sonner";
import dynamic from "next/dynamic";
import { Modal } from "./ui/modal";
import { TextareaField } from "./ui/field";

/**
 * 대화창과 오른쪽 상세는 **대화를 누르기 전엔 렌더되지 않는다**(아래 `activeChat &&`).
 * 그런데 정적 import라 화면에 들어오는 순간 24KB를 미리 받고 있었다 — 목록만 보고
 * 나가는 경우엔 통째로 낭비다. 첫 클릭 때 받아온다.
 *
 * 상세 패널이 ConversationThread를 물고 있어 둘은 어차피 같은 덩어리로 묶인다.
 * ssr: false — 둘 다 클라이언트 전용(fetch·폴링·실시간)이라 서버에서 그릴 것이 없다.
 */
const ConversationThread = dynamic(
  () => import("./ConversationThread").then((m) => m.ConversationThread),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        대화 불러오는 중…
      </div>
    ),
  },
);

const ApplicantDetailContent = dynamic(
  () => import("./ApplicantDetailPanel").then((m) => m.ApplicantDetailContent),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        불러오는 중…
      </div>
    ),
  },
);
import { getBrowserClient } from "@/lib/supabase";
import { defaultFocusJobId, type LiveJobLink } from "@/lib/candidate-links";
import { Button } from "@/components/ui/button";

interface Applicant {
  id: number;
  name: string;
  phone: string | null;
  status: string;
  agent_stage?: string | null;
  availability?: string | null;
  source?: string | null;
  branch?: string | null;
  branch1?: string | null;
  created_at?: string | null;
  last_message_at?: string | null;
  sms_opt_out_at?: string | null;
  /**
   * 목록 API가 사람마다 함께 내려주는 '살아있는 공고 결속'.
   * /api/admin/applicants/[id]/active-jobs 와 **같은 함수**(gatherLiveJobLinks)가 만든 같은 배열이라
   * 대화를 열 때 다시 물어볼 필요가 없다. 예전엔 이 필드가 타입에 없어 그대로 버려졌고,
   * 대화를 누를 때마다 같은 값을 서버에 한 번 더 물었다.
   */
  job_links?: LiveJobLink[];
}

/** /api/admin/applicants/[id]/active-jobs 응답 — lib/candidate-links의 LiveJobLink와 같은 모양이어야 한다. */
type ActiveJob = LiveJobLink;

/** /api/admin/messages/preview 응답의 지원자별 마지막 메시지 요약 */
interface LastMessagePreview {
  body: string;
  direction: string;
  created_at: string;
  sent_by?: string | null;
  /** 마지막 메시지가 매니저 수동 발신(캠페인 벌크·AI 제외) — '답 대기' 판정용 */
  manual_outbound?: boolean;
  last_inbound_at?: string | null;
  pending_draft?: boolean;
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
  urgent: "bg-error-soft text-error-strong border-error/30",
  answerable: "bg-yellow-50 text-warning-strong border-yellow-200",
  human: "bg-info-soft text-info-strong border-info/25",
  neutral: "bg-background text-gray-700 border-border-strong",
};

/** 방치 경과일 색 — 오래될수록 빨강(SLA 환기). */
function ageStyle(days: number): string {
  if (days >= 7) return "text-error-strong";
  if (days >= 3) return "text-warning";
  return "text-muted-foreground";
}

// 표시 라벨만 실무 언어로 통일(ApplicantDetailPanel·Jobs·Dashboard와 동일 단어) — DB 값(agent_stage)은 그대로.
const STAGE_KO: Record<string, string> = {
  exploration: "초기 대화",
  screening: "스크리닝",
  onboarding: "온보딩",
  active: "활동 중",
  paused: "수동 응대",
  abort: "중단",
};

// 이름 해시로 고르는 정체성 색이라 상태색이 아니라 categorical 슬롯을 쓴다.
const AVATAR_PALETTE = [
  { bg: "var(--chart-1-soft)", fg: "var(--chart-1)" },
  { bg: "var(--chart-2-soft)", fg: "var(--chart-2)" },
  { bg: "var(--chart-3-soft)", fg: "var(--chart-3)" },
  { bg: "var(--chart-4-soft)", fg: "var(--chart-4)" },
  { bg: "var(--chart-5-soft)", fg: "var(--chart-5)" },
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

// 목록 기본 통과 조건: (1) 활성 대화(agent_stage) (2) 스크리닝 status.
// applicants.unread_count는 판정에서 뺐다 — 그 값은 '스레드를 아직 열지 않았다'는 신호라(트리거가 inbound마다 +1,
// 열람 시 0으로 리셋) 열람만으로 목록에서 빠지는 부작용이 있었다. 답장 온 풀 응답자는 아래 최근 inbound
// (last_message_at, RECENT_INBOUND_MS) 조건으로 들어오고, 미답 판정은 '마지막 메시지가 inbound'로 한다.
function isBaseChat(a: Applicant): boolean {
  return (!!a.agent_stage && a.agent_stage !== "abort") || ACTIVE_STATUSES.has(a.status);
}

// 풀 응답자(agent_stage 없음)가 목록에 남는 기간(최근 답장 기준).
// '답 대기'(매니저 발신 후 회신 대기) 대화가 목록에 남는 기간으로도 함께 쓴다.
const RECENT_INBOUND_MS = 14 * 24 * 60 * 60 * 1000;

// 미리보기 조회 대상 상한 — 목록 후보가 많아져도 최근 활동순 상위만 조회(URL 길이·메시지 스캔 부하 방지)
// 미리보기 대상 선정 규칙(활동 14일·상한 150)은 서버로 옮겼다 —
// app/api/admin/applicants/route.ts 의 scope=live 분기가 같은 값을 쓴다.

// 빈 미리보기 — 매 렌더 새 객체를 만들면 이 값에 의존하는 useMemo가 계속 무효화된다.
const EMPTY_PREVIEWS: Record<number, LastMessagePreview> = {};

// '답 대기'(표시 라벨 '상대 답 기다림') 판정: 마지막 메시지가 매니저 수동 발신(14일 내) — 내가 보내고 회신을 기다리는 대화.
// 캠페인 벌크 핑(system-bulk)·AI 발송은 서버(preview API)가 manual_outbound=false로 걸러준다.
function isAwaitingPreview(pv: LastMessagePreview | undefined): boolean {
  return !!pv?.manual_outbound && !!pv.created_at && Date.now() - new Date(pv.created_at).getTime() < RECENT_INBOUND_MS;
}

// 카드 상태를 '누구 차례냐' 단일 축 배지 하나로 압축(간소화).
// 이전엔 카드당 최대 6개 배지(미답·개입필요·풀응답·초안대기·수동응대·AI응대중 + 가용성·수신거부)가
// 겹쳐 무엇을 먼저 봐야 할지 헷갈렸다. 실무자의 질문은 하나 — "지금 내가 답할 것이 뭐지?".
// 우선순위: 수신거부 > 초안 검토 > 내가 답할 차례 > 수동 응대 > AI 응대 중 > 상대 답 기다림 > (그 외).
interface TurnBadge { label: string; cls: string; sub?: string }
function whoseTurn(chat: Applicant, pv: LastMessagePreview | undefined): TurnBadge {
  const unanswered = pv?.direction === "inbound";
  if (chat.sms_opt_out_at) return { label: "수신거부", cls: "bg-error-soft text-error-strong border border-error/30" };
  if (pv?.pending_draft) return { label: "초안 검토", cls: "bg-copilot-soft text-copilot-strong border border-copilot/30" };
  if (unanswered) {
    // 활성 대화 없이 답장 온 재컨택 응답자 = 스크리닝 스코프 밖 답장. 서브라벨로만 구분(별도 색 배지 X).
    const isPool = (!chat.agent_stage || chat.agent_stage === "abort") && !ACTIVE_STATUSES.has(chat.status);
    return { label: "내가 답할 차례", cls: "bg-error-soft text-error-strong border border-error/30", sub: isPool ? "풀 밖 답장" : undefined };
  }
  if (chat.agent_stage === "paused") return { label: "수동 응대", cls: "bg-muted text-gray-700" };
  if (isAwaitingPreview(pv)) return { label: "상대 답 기다림", cls: "bg-muted text-muted-foreground" };
  if (chat.agent_stage && chat.agent_stage !== "abort") return { label: "AI 응대 중", cls: "bg-info-soft text-info-strong border border-info/25" };
  return { label: chat.status, cls: "bg-background text-muted-foreground border border-border-strong" };
}

export function LiveConsole() {
  // 탭 ↔ URL(?tab=confirm|intervention) 양방향 동기화.
  // 딥링크(사이드바 '확정할 지원자'·대시보드 CTA)로 들어와도 탭이 열리고, 탭을 바꾸면 URL도 따라가
  // 새로고침·공유가 보던 화면과 일치한다.
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const urlTab: "all" | "intervention" | "confirm" =
    tabParam === "confirm" || tabParam === "intervention" ? tabParam : "all";
  const [activeTab, setActiveTabState] = useState<"all" | "intervention" | "confirm">(urlTab);
  // URL → 상태: 사이드바 '확정할 지원자'·대시보드 CTA처럼 쿼리만 바뀌는 이동에도 탭이 따라간다
  // (쿼리 변경은 리마운트가 아니라 re-render라 useState 초기값만으로는 반영되지 않는다).
  useEffect(() => {
    setActiveTabState(urlTab);
  }, [urlTab]);
  // 상태 → URL: router.replace는 RSC 왕복을 유발해 (a) 응답까지 탭이 안 바뀌고 (b) 그 요청이 실패하면
  // 전체 페이지 리로드로 폴백해 작성 중인 문자 초안·편집이 날아간다. 탭은 즉시 바꾸고 URL만 얕게 맞춘다
  // (Next 14는 history.replaceState를 패치해 useSearchParams도 함께 갱신한다.)
  const setActiveTab = useCallback((t: "all" | "intervention" | "confirm") => {
    setActiveTabState(t);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", t === "all" ? "/live" : `/live?tab=${t}`);
    }
  }, []);
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  // 멀티-잡: 선택된 지원자가 동시에 진행 중인 공고들 + 현재 보고 있는 공고
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  // 인계 작업 큐(paused 후보) + 카테고리 필터 + 큐에서 선택한 공고 포커스용
  const [handoffCat, setHandoffCat] = useState<string>("all");
  // 인계 큐에서 특정 공고로 포커스해 열 때 사용(ref라 effect 재실행을 유발하지 않음)
  const focusJobIdRef = useRef<number | null>(null);
  // 그 공고가 '살아있는 결속' 밖일 때(시스템 더미·마감 공고의 paused 건) 탭에 끼워 넣을 링크.
  // 인계 큐는 마감·시스템 공고도 그대로 띄우는데(의도) /active-jobs는 그 둘을 제외한다 —
  // 그러면 큐에서 고른 공고가 목록에 없어 **조용히 다른 공고로 떨어지고**, 인계된 대화가 화면에서
  // 사라진 채 매니저 답장이 엉뚱한 공고로 적재된다(#{공고명} 치환까지 그 공고 값으로 나간다).
  const focusLinkRef = useRef<ActiveJob | null>(null);
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
  // scope=live — 행은 그대로 전원이고 컬럼만 이 화면이 읽는 11개로 줄인 응답.
  // 실측 전송량(gzip): 95KB → 22KB.
  //
  // 트레이드오프: 예전엔 대시보드·파이프라인과 **같은 키**라 다른 탭을 거쳐 들어오면 캐시로
  // 즉시 떴다. 키가 갈라지면서 그 이득은 없어진다. 사이드바에서 바로 들어오는 게 이 화면의
  // 주 동선이고, 그 경우 95KB 대신 22KB를 받으므로 순이득이라 판단했다.
  //
  // 행을 안 줄이는 이유는 라우트의 LIVE_COLUMNS 주석에 있다(확정 직후 패널 소실·인계 큐
  // 대화 안 열림·'모두 응대했어요'라는 조용한 거짓).
  // refreshInterval — 이 화면의 갱신은 DB 트리거 → 실시간 broadcast 채널에 걸려 있는데,
  // 폴링이 하나도 없어서 웹소켓이 끊기면 좌측 목록이 조용히 멈췄다. 대화창은 12초로 계속
  // 갱신되니 화면은 살아 있어 보이고, 새로 답장한 사람만 안 뜬다. 다른 창을 갔다 와도
  // 갱신되지 않는다(전역 revalidateOnFocus: false). 백스톱으로 60초를 둔다 —
  // 위 scope=live로 응답이 22KB(gzip)로 줄어서 이제 이 주기를 감당할 수 있다(예전 95KB).
  const { data: appsData, isLoading: appsLoading, isValidating: appsValidating, mutate: mutateApps } = useSWR<{ data?: Applicant[]; previews?: Record<number, LastMessagePreview> }>("/api/admin/applicants?scope=live", { refreshInterval: 60_000 });
  // 대화를 고를 때 목록의 최신 스냅샷을 읽되, 목록이 갱신됐다는 이유로 선택 로직이 다시 돌지는
  // 않게 한다. 의존성에 appsData를 넣으면 새 문자가 들어와 목록이 갱신될 때마다 매니저가 골라둔
  // 공고 탭이 풀린다.
  const appsRef = useRef<{ data?: Applicant[] } | undefined>(undefined);
  useEffect(() => {
    appsRef.current = appsData;
  }, [appsData]);
  const appsLoaded = !!appsData;
  // 미리보기는 목록 응답에 함께 실려 온다 — 별도 state가 아니다.
  //
  // 예전에는 목록을 받은 뒤 미리보기를 다시 물어 state에 담았다. 그런데 아래 `chats`의
  // 통과 조건이 이 값에 걸려 있어서, 화면에 처음 뜨는 명단과 미리보기가 도착한 뒤의
  // 명단이 **서로 달랐다** — 사람이 나타나고 사라지고, 미리보기 줄과 배지가 뒤늦게 붙었다.
  // 서버가 한 응답에 같이 실어 보내므로 첫 렌더부터 최종 명단이 그려진다.
  const previewById = appsData?.previews ?? EMPTY_PREVIEWS;
  // 목록 통과 조건: 기본 조건(활성 대화·스크리닝·미열람 답장) 또는 '최근 14일 내 inbound 있음'(풀 응답)
  // 또는 '마지막 메시지가 매니저 수동 발신'(답 대기) — 발신만 하고 회신을 기다리는 대화(빠른 컨택 등)가
  // 목록에서 사라지지 않는다. previewById에는 서버가 합집합으로 찾아준 답 대기 건도 들어있다.
  const chats = useMemo(
    () =>
      (appsData?.data ?? []).filter((a) => {
        if (isBaseChat(a)) return true;
        const pv = previewById[a.id];
        if (!pv) return false;
        // 미답(마지막 메시지가 지원자 답장)은 기간 제한 없이 남는다 — 예전엔 14일이 지나면
        // 아무도 답하지 않았어도 목록에서 사라졌고, 화면은 "진행 중인 대화가 없어요"라는
        // 정상 화면으로 그 사실을 덮었다. 처리한 대화(마지막이 우리 발신)만 14일 뒤 접는다.
        if (pv.direction === "inbound") return true;
        const li = pv.last_inbound_at;
        if (li && Date.now() - new Date(li).getTime() < RECENT_INBOUND_MS) return true;
        return isAwaitingPreview(pv);
      }),
    [appsData, previewById]
  );
  const loadingList = appsLoading && chats.length === 0;

  // 미답 판정(A2): '마지막 메시지가 inbound(지원자 답장)' 기준. 대시보드 답장 큐와 같은 규칙.
  const isUnanswered = useCallback(
    (c: Applicant) => previewById[c.id]?.direction === "inbound",
    [previewById]
  );
  // 답 대기 판정 — 미답이 우선이므로 미답이 아닌 것 중에서만
  const isAwaiting = useCallback(
    (c: Applicant) => !isUnanswered(c) && isAwaitingPreview(previewById[c.id]),
    [isUnanswered, previewById]
  );
  const unansweredCount = useMemo(() => chats.filter(isUnanswered).length, [chats, isUnanswered]);
  // 카드 시각·정렬 기준 — 마지막 메시지 시각(미리보기)과 last_message_at(inbound 수신 시각) 중 더 최근.
  // 매니저 발신은 last_message_at을 갱신하지 않아, 미리보기 시각이 있어야 답 대기 대화도 최신순에 올바로 낀다.
  const lastActivityAt = useCallback(
    (c: Applicant): string | null => {
      const pv = previewById[c.id]?.created_at ?? null;
      const lm = c.last_message_at ?? null;
      if (pv && lm) return new Date(pv).getTime() >= new Date(lm).getTime() ? pv : lm;
      return pv ?? lm ?? c.created_at ?? null;
    },
    [previewById]
  );

  // 인계 큐도 SWR로 캐시.
  // 인계 큐도 broadcast 하나에 의존하고 있었다 — 사람이 직접 답해야 하는 대화가 새로
  // 들어와도 화면을 열어둔 매니저에게는 안 떴다. 응답이 1KB대라 60초 폴링 비용이 없다.
  const { data: handoffsData, mutate: mutateHandoffs } = useSWR<{ handoffs?: Handoff[] }>("/api/admin/agent/handoffs", { refreshInterval: 60_000 });
  const handoffs = useMemo(() => handoffsData?.handoffs ?? [], [handoffsData]);

  // 확정 대기 큐(온보딩 완료·미확정) SWR.
  const { data: confirmData, mutate: mutateConfirm } = useSWR<{ pending?: ConfirmPending[] }>("/api/admin/confirm/pending");
  const confirmPending = useMemo(() => confirmData?.pending ?? [], [confirmData]);

  // 전역 킬스위치 상태 — 꺼져 있으면 목록 상단 경고 배너 + 스레드 배지·입력창 동작이 바뀐다.
  // env_forced(AGENT_DISABLED=1)도 토글과 무관하게 항상 중단이므로 함께 '전역 중지'로 취급.
  // mode='draft'(코파일럿)는 AI가 초안만 만드는 상태 — 별도 배너·배지로 안내한다.
  // AI 응답 모드는 주기적으로 다시 확인한다.
  //
  // 이 값이 이 화면의 '지금 AI가 답하고 있다' 배너와 수동 발송 잠금을 좌우한다.
  // 그런데 폴링이 없어서, 다른 사람이 /brain에서 AI를 꺼도 이 화면을 열어둔 매니저는
  // 페이지를 새로 열 때까지 옛 값을 보고 있었다 — 성능이 아니라 사고 방지 쪽이다.
  // 응답이 몇 바이트짜리라 30초로 잡아도 비용이 없다.
  const { data: killData } = useSWR<{ mode?: "auto" | "draft" | "off"; disabled?: boolean; env_forced?: boolean }>(
    "/api/admin/agent/kill-switch",
    { refreshInterval: 30_000 },
  );
  const globalKill = killData?.disabled === true || killData?.env_forced === true;
  const copilotMode = !globalKill && killData?.mode === "draft";

  // 확정 모달 오픈 신호 — 큐의 '확정' 버튼이 상세 패널의 확정 모달(지점·슬롯·시작일 수집)을 열게 한다.
  // 대상 지원자 id를 함께 실어야 한다: 패널은 applicantId가 key라 지원자를 바꾸면 리마운트되므로
  // 단순 카운터는 신호가 유실된다. 열리면 패널이 소비 콜백으로 알려 신호를 비운다.
  const [confirmSignal, setConfirmSignal] = useState<{ id: number; n: number; jobId: number | null } | null>(null);
  const confirmSignalSeq = useRef(0);

  // 대화 상태가 바뀌면(재개/보류/발송/브로드캐스트) 목록·인계·확정 큐를 함께 새로고침.
  // 발송 후 onChanged와 DB 브로드캐스트가 거의 동시에 도착하므로 800ms 디바운스로 1회만 조회한다.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleChanged = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void mutateApps();
      void mutateHandoffs();
      void mutateConfirm();
    }, 800);
  }, [mutateApps, mutateHandoffs, mutateConfirm]);
  useEffect(() => () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);

  // 첫 대화 자동 선택은 하지 않는다 — 탭 진입만으로 열람 처리되는 부작용을 피한다.
  // 선택 전에는 빈 상태 안내를 보여준다.

  // 미리보기 별도 조회는 없앴다 — 목록 응답(scope=live)에 함께 실려 온다.
  //
  // 예전에는 목록이 도착한 뒤 그 안의 id로 /api/admin/messages/preview를 한 번 더 불렀다.
  // 그런데 위 `chats`의 통과 조건이 그 두 번째 응답에 걸려 있어서, 화면에 처음 뜨는 명단과
  // 1초 뒤 명단이 서로 달랐다. 대상 선정 규칙(활동 14일·상한 150)은 서버로 옮겼다
  // (app/api/admin/applicants/route.ts — 클라이언트와 같은 규칙이어야 한다).

  // 실시간 갱신(③): DB 트리거가 messages/job_candidates 변경 시 'live-console' 토픽으로
  // PII 없는 "changed" 신호만 broadcast → 디바운스된 handleChanged로 목록·큐를 재조회한다.
  // (테이블 직접 구독이 아니라 공개 broadcast라 anon에 데이터가 노출되지 않는다.)
  useEffect(() => {
    const supabase = getBrowserClient();
    const channel = supabase
      .channel("live-console")
      .on("broadcast", { event: "changed" }, () => handleChanged())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [handleChanged]);

  // 선택 지원자가 바뀌면 그 사람이 동시에 진행 중인 공고 목록을 불러온다.
  // 2건 이상이면 대화창 상단에 공고 탭이 떠서 공고별로 스레드·체크리스트·AI 토글이 분리된다.
  useEffect(() => {
    if (selectedChatId == null) {
      setActiveJobs([]);
      setSelectedJobId(null);
      return;
    }
    // 사람을 바꾸는 즉시 앞사람의 공고 선택을 버린다.
    // 예전엔 여기서 비우지 않아, B를 눌러도 /active-jobs 응답이 오기 전까지 selectedJobId가
    // A의 공고 번호 그대로였다. 그 상태로 대화창이 먼저 뜨면서 'B에게 있지도 않은 공고'로
    // 메시지를 조회했고(빈 대화창이 한 번 번쩍임), 응답이 오면 올바른 공고로 다시 조회했다.
    // 클릭 한 번에 조회가 두 번 나가고 첫 번째는 틀린 값이었다.
    // 큐에서 고른 공고가 살아있는 결속 목록에 없으면(마감·시스템 공고) 그 링크를 끼워 넣는다 —
    // 조용히 다른 공고로 떨어지지 않게. 판정(gatherLiveJobLinks)은 건드리지 않는다:
    // 이건 '매니저가 지목한 예외 탭'이고 살아있는 결속의 정의가 아니다(목록 배지 = 탭 수 불변식 유지).
    // 인계 큐에서 특정 공고를 골라 들어왔으면 그 공고로 포커스, 아니면 **대화가 진행 중인 공고**를 먼저.
    // (탭에 관심만 누른 공고까지 들어오면서, 먼저 생겼다는 이유로 빈 대화창이 기본이 되는 걸 막는다.)
    const apply = (jobs: ActiveJob[]) => {
      const wanted = focusJobIdRef.current;
      const extra = focusLinkRef.current;
      const merged =
        wanted != null && extra != null && !jobs.some((j) => j.job_id === wanted) ? [...jobs, extra] : jobs;
      setActiveJobs(merged);
      setSelectedJobId(defaultFocusJobId(merged, wanted));
      focusJobIdRef.current = null;
      focusLinkRef.current = null;
    };

    // 목록이 이미 같은 값을 실어 보냈으면 서버에 다시 묻지 않는다 — 대화 클릭마다 왕복 1회가 빠지고,
    // 공고 선택이 즉시 정해지므로 대화 내역 조회도 한 번으로 끝난다(예전엔 '전체'로 한 번, 공고가
    // 정해진 뒤 또 한 번이었다). 목록에 아직 없는 사람(딥링크 등)만 예전 경로로 물어본다.
    const fromList = (appsRef.current?.data ?? []).find((a) => a.id === selectedChatId)?.job_links;
    if (fromList) {
      apply(fromList);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/applicants/${selectedChatId}/active-jobs`);
        const json = await res.json();
        if (cancelled) return;
        apply((json.jobs ?? []) as ActiveJob[]);
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

  // 선택한 사람이 목록 필터에서 빠져도(확정 직후 상태 변화·14일 넘은 대화 등) 열어둔 상세는 유지한다 —
  // 확정 후 "오른쪽 상세에서 만남장소를 보내세요"라고 안내했는데 패널이 사라지던 문제 방어.
  const activeChat =
    chats.find((c) => c.id === selectedChatId) ??
    (appsData?.data ?? []).find((c) => c.id === selectedChatId) ??
    null;

  // 인계 큐: 카테고리 필터 적용(이미 오래된 순으로 서버 정렬됨)
  const visibleHandoffs = handoffCat === "all" ? handoffs : handoffs.filter((h) => h.category === handoffCat);
  // **한 사람 = 한 카드** — 공고를 여러 개 동시에 열면 한 분이 공고 수만큼 카드로 불어난다(같은 사람에게
  // 전화를 세 번 하게 되는 지점). 사람으로 묶고 그 안에서 공고별 줄로 나눈다.
  // Map은 삽입 순서를 유지하므로 '가장 오래 방치된 사람이 위'라는 서버 정렬이 그대로 보존된다.
  const handoffGroups = useMemo(() => {
    const byApplicant = new Map<number, Handoff[]>();
    for (const h of visibleHandoffs) {
      const arr = byApplicant.get(h.applicant_id);
      if (arr) arr.push(h);
      else byApplicant.set(h.applicant_id, [h]);
    }
    return Array.from(byApplicant.values());
  }, [visibleHandoffs]);
  // 카테고리 칩에 쓸 집계
  const catCounts = handoffs.reduce<Record<string, number>>((acc, h) => {
    acc[h.category] = (acc[h.category] ?? 0) + 1;
    return acc;
  }, {});
  const catOrder = Array.from(new Set(handoffs.map((h) => h.category)));

  // 큐에서 한 건 선택 → 해당 지원자 대화 + 그 공고로 포커스
  const selectHandoff = (h: Handoff) => {
    focusJobIdRef.current = h.job_id;
    // 큐의 branch는 지원자 지점이 섞여 오므로 탭 라벨은 공고명으로만 만든다.
    focusLinkRef.current = { job_id: h.job_id, title: h.job_title, branch: null, agent_stage: "paused", created_at: null, stage_updated_at: h.paused_at ?? null };
    if (h.applicant_id === selectedChatId) {
      // 이미 보고 있는 지원자의 '다른 공고' 인계를 고른 경우: selectedChatId가 그대로라
      // active-jobs 로딩 effect가 재실행되지 않으므로 공고 탭을 직접 전환한다.
      // 그 공고가 탭 목록에 없으면(마감·시스템 공고) 함께 끼워 넣는다 — 없으면 탭 바에서 사라진 채
      // 선택만 바뀌어, 매니저가 어느 공고로 답장하는지 화면에서 확인할 수 없다.
      setActiveJobs((prev) => (prev.some((j) => j.job_id === h.job_id) ? prev : [...prev, focusLinkRef.current!]));
      setSelectedJobId(h.job_id);
      focusJobIdRef.current = null;
      focusLinkRef.current = null;
    } else {
      setSelectedChatId(h.applicant_id);
    }
  };

  // '처리 완료' — 전화·문자로 직접 해결한 인계 건을 큐에서 내보낸다(AI는 계속 정지).
  // 예전엔 이 출구가 없어서, 전화로 끝낸 건도 카드가 남아 방치 일수만 올랐다(실측 30일·22일).
  // 결과 3택+한 줄 메모는 pool_events로 타임라인에 남는다 — 유선면접이 처음으로 제품 안에 기록된다.
  const [resolveTarget, setResolveTarget] = useState<Handoff | null>(null);
  const [resolveOutcome, setResolveOutcome] = useState<"call" | "sms" | "closed">("call");
  const [resolveNote, setResolveNote] = useState("");
  const [resolveSaving, setResolveSaving] = useState(false);
  const openResolve = (h: Handoff) => {
    setResolveTarget(h);
    setResolveOutcome("call");
    setResolveNote("");
  };
  const submitResolve = async () => {
    if (!resolveTarget || resolveSaving) return;
    setResolveSaving(true);
    try {
      const res = await fetch("/api/admin/agent/handoffs/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_id: resolveTarget.candidate_id, outcome: resolveOutcome, note: resolveNote }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        toast.error(json?.error || "처리 완료에 실패했어요.");
        return;
      }
      toast.success(`${resolveTarget.applicant_name}님 — 처리 완료로 기록했어요. AI는 계속 정지 상태예요.`);
      setResolveTarget(null);
      handleChanged();
    } catch {
      toast.error("처리 완료에 실패했어요.");
    } finally {
      setResolveSaving(false);
    }
  };

  // AI 재개 — 봇이 다시 응대를 이어받는다. 큐에서 즉시 제거되도록 새로고침.
  const resumeHandoff = async (h: Handoff) => {
    try {
      const res = await fetch("/api/admin/agent/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: h.applicant_id, job_id: h.job_id }),
      });
      if (!res.ok) {
        // 서버가 이유를 준다(예: 진행 중 공고가 여러 개 → 골라 달라). 삼키면 원인을 알 수 없다.
        const json = await res.json().catch(() => null);
        toast.error(json?.error || "재개에 실패했어요.");
        return;
      }
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

  // ── 확정 대기 액션 ──
  // 후속 안내(만남장소·첫날규칙·앱안내) 발송은 이 큐에 없다 — 확정 전이라 확정 통보로 읽히기 때문.
  // 발송은 확정 후 지원자 상세의 FollowupSendModal(공용 /api/admin/confirm/send)이 담당한다.
  // 큐의 '확정'은 상세 패널의 확정 모달을 연다 — 예전엔 여기서 status만 바꾸는 '빠른 확정'이라
  // 지점·슬롯·시작일이 비어 확정 데이터 품질이 경로마다 갈렸다. 이제 어디서 확정하든 같은 정보를 받는다.
  const openConfirmFor = (p: ConfirmPending) => {
    setSelectedChatId(p.applicant_id);
    confirmSignalSeq.current += 1;
    // 큐 카드가 고른 대상 공고(jobId)를 함께 넘긴다 — 큐는 '진행단계 우선', 모달 기본 시드는 '최신 링크'라
    // 열린 링크가 2개 이상이면 카드에 보인 공고와 모달 선택이 어긋나 다른 공고로 확정될 수 있다
    // (충원율·라인 경험·집결지 오귀속). 매니저가 카드에서 본 그 공고가 시드가 되게 한다.
    setConfirmSignal({ id: p.applicant_id, n: confirmSignalSeq.current, jobId: p.job_id ?? null });
    // 확정 모달은 우측 상세 패널 안에 있어, 목록·상세 조회가 실패하면 아무 일도 안 일어난 것처럼 보인다
    // (예전 빠른 확정은 직접 PATCH라 실패 토스트가 떴다). 잠시 뒤에도 안 열렸으면 원인을 알려준다.
    window.setTimeout(() => {
      setConfirmSignal((cur) => {
        if (!cur || cur.id !== p.applicant_id) return cur; // 이미 열려 소비됐음
        toast.error(`${p.name}님 상세를 불러오지 못해 확정 창을 열 수 없었어요. 새로고침 후 다시 시도해 주세요.`);
        return null;
      });
    }, 6000);
  };

  // 목록 필터 + 우선순위 정렬 — 미답(빨강) > 초안 대기(⚡) > 답 대기(⏱) > 나머지,
  // 같은 그룹 안에서는 마지막 활동 최신순. 폴링·브로드캐스트마다 재계산하지 않게 useMemo.
  const visibleChats = useMemo(() => {
    const rank = (c: Applicant): number => {
      if (isUnanswered(c)) return 3;
      if (previewById[c.id]?.pending_draft) return 2;
      if (isAwaiting(c)) return 1;
      return 0;
    };
    const q = search.trim().toLowerCase();
    // 숫자 3자리 이상이면 전화번호(숫자열) 부분일치도 함께 검색
    const qDigits = q.replace(/\D/g, "");
    return chats
      .filter((c) => {
        if (q) {
          const nameHit = c.name.toLowerCase().includes(q);
          const phoneHit = qDigits.length >= 3 && (c.phone ?? "").replace(/\D/g, "").includes(qDigits);
          if (!nameHit && !phoneHit) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ar = rank(a);
        const br = rank(b);
        if (ar !== br) return br - ar;
        const at = new Date(lastActivityAt(a) ?? 0).getTime();
        const bt = new Date(lastActivityAt(b) ?? 0).getTime();
        return bt - at;
      });
  }, [chats, search, isUnanswered, isAwaiting, previewById, lastActivityAt]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-card lg:flex-row">
      {/* Left Sidebar */}
      <div className="flex w-full shrink-0 flex-col border-b border-border-strong bg-background lg:w-[320px] lg:border-b-0 lg:border-r">
        {/* 전역 킬스위치 경고 — 켜져 있는 줄 알고 기다리는 교착을 방지 */}
        {globalKill && (
          <div className="shrink-0 bg-yellow-50 border-b border-yellow-300 px-4 py-2.5 flex items-start gap-2 text-[12px] font-bold text-warning-strong leading-snug">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>
              AI 전역 응답이 꺼져 있습니다 — 수동 응대만 발송됩니다 (
              <Link href="/brain" className="underline underline-offset-2">에이전트 두뇌</Link>
              에서 변경)
            </span>
          </div>
        )}
        {copilotMode && (
          <div className="shrink-0 bg-copilot-soft border-b border-copilot/30 px-4 py-2.5 flex items-start gap-2 text-[12px] font-bold text-copilot-strong leading-snug">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>
              코파일럿 모드 — AI는 초안만 만들고, 발송은 매니저 승인 후에만 됩니다 (
              <Link href="/brain" className="underline underline-offset-2">에이전트 두뇌</Link>
              에서 변경)
            </span>
          </div>
        )}
        <div className="p-5 border-b border-border-strong bg-card flex flex-col gap-3">
          {/* 배경 갱신 표시 — 데이터가 있는데 새로 불러오는 중이면 '갱신 중'(전체 스켈레톤 대신 비침투적 힌트). */}
          {appsValidating && !loadingList && chats.length > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" /> 최신 데이터로 갱신 중…
            </div>
          )}
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} type="text" placeholder="이름·전화번호 검색" className="w-full pl-9 pr-4 py-2 border border-border-strong rounded-2xl text-sm focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring bg-muted" />
          </div>
          {/* 탭 라벨이 길어져(사람 확인 필요) 320px 사이드바에서 한 줄에 안 들어갈 수 있어 wrap 허용 */}
          <div className="flex gap-1.5 flex-wrap">
            <button aria-selected={activeTab === "all"} role="tab" onClick={() => setActiveTab("all")} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${activeTab === "all" ? "bg-foreground text-white" : "bg-white border border-border-strong text-muted-foreground"}`}>전체 <span className="opacity-60 ml-1">{chats.length}</span></button>
            <button aria-selected={activeTab === "intervention"} role="tab" onClick={() => setActiveTab("intervention")} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${activeTab === "intervention" ? "bg-error text-white" : "bg-white border border-border-strong text-muted-foreground"}`}>사람 확인 필요 <span className="opacity-60 ml-1">{handoffs.length}</span></button>
            <button aria-selected={activeTab === "confirm"} role="tab" onClick={() => setActiveTab("confirm")} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${activeTab === "confirm" ? "bg-success-strong text-white" : "bg-white border border-border-strong text-muted-foreground"}`}>확정 대기 <span className="opacity-60 ml-1">{confirmPending.length}</span></button>
          </div>
          {/* 전체 탭: 하위 필터칩을 제거하고 목록을 긴급도순 자동 정렬(내가 답할 차례→AI→상대 답 기다림)로 대체(간소화).
              '미답 N'만 상단에 요약해 남긴다 — 필터를 누르지 않아도 지금 답할 게 몇 건인지 바로 보이게.
              사람 확인 필요 탭은 사유 카테고리 필터를 유지(작업 큐라 세분 필요). */}
          {activeTab === "all" ? (
            unansweredCount > 0 ? (
              <div className="text-[12px] font-bold text-error flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-error" />
                지금 답할 대화 {unansweredCount}건 — 목록 맨 위에 있어요
              </div>
            ) : (
              <div className="text-[12px] font-semibold text-success">답할 대화 없음 — 모두 응대했어요 👍</div>
            )
          ) : activeTab === "intervention" ? (
            <div className="flex gap-1 flex-wrap">
              {/* 탭 숫자는 '건'(공고별), 카드는 '사람' — 두 숫자가 다른 이유를 여기서 밝힌다.
                  한 분이 공고 3건으로 넘어오면 3건 · 1명이 된다. */}
              {visibleHandoffs.length !== handoffGroups.length && (
                <span className="w-full text-[12px] font-bold text-muted-foreground">
                  {visibleHandoffs.length}건 · {handoffGroups.length}명 — 한 분이 여러 공고에서 넘어오면 카드 하나로 묶어 보여줘요
                </span>
              )}
              <button aria-pressed={handoffCat === "all"} onClick={() => setHandoffCat("all")} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-2.5 py-1 rounded-full text-[12px] font-bold transition-all ${handoffCat === "all" ? "bg-brand-yellow text-foreground" : "bg-white border border-border-strong text-muted-foreground"}`}>전체 {handoffs.length}</button>
              {catOrder.map((cid) => {
                const sample = handoffs.find((h) => h.category === cid)!;
                return (
                  <button aria-pressed={handoffCat === cid} key={cid} onClick={() => setHandoffCat(cid)} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-2.5 py-1 rounded-full text-[12px] font-bold transition-all ${handoffCat === cid ? "bg-brand-yellow text-foreground" : "bg-white border border-border-strong text-muted-foreground"}`}>{sample.category_label} {catCounts[cid]}</button>
                );
              })}
            </div>
          ) : null}
          {/* 대량 발송 진입점 — 큰 버튼 대신 작은 링크로(개별 응대 화면에서 실사용 빈도 낮음) */}
          <Link href="/pipeline" className="relative self-start flex min-h-8 items-center gap-1 rounded-md py-1.5 text-[12px] font-bold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            대량 발송은 파이프라인에서 <ArrowRight size={13} />
          </Link>
        </div>

        {/* 사람 확인 필요 탭: paused 후보 작업 큐(오래된 순). 카테고리 배지 + 경과일 + 사유 요약. */}
        {activeTab === "intervention" ? (
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 [&>*]:shrink-0">
            {handoffGroups.length === 0 && <div className="text-[13px] text-muted-foreground p-4 text-center">사람이 확인할 대화가 없어요. AI가 답하기 어려운 대화가 생기면 여기로 넘어옵니다.</div>}
            {handoffGroups.map((items) => {
              const head = items[0];
              const multi = items.length > 1;
              // 카드 위치는 '가장 오래 방치된 건' 기준(서버 정렬) — 머리글 경과일도 그 값으로 맞춘다.
              const worstAge = Math.max(...items.map((h) => h.age_days));
              const groupSelected = selectedChatId === head.applicant_id;
              return (
                <div
                  key={head.applicant_id}
                  className={`rounded-2xl transition-all ${groupSelected ? "bg-card border border-brand-yellow shadow-sm ring-1 ring-brand-yellow" : "bg-card border border-transparent hover:border-border-strong"}`}
                >
                  {/* 이름 줄도 눌러서 연다 — 카드에서 가장 크고 굵은 요소가 죽어 있으면
                      "안 열리는구나"라고 학습하고 떠난다(제목 클릭은 카드 UI의 기본 관습).
                      전화 버튼을 카드에 올린다 — 30일 멈춘 대화에 필요한 건 AI 재개가 아니라
                      전화인데, 예전엔 대화를 연 뒤 상세 패널까지 3클릭이었다. */}
                  <div className="flex items-center justify-between gap-2 px-3.5 pt-3 pb-1.5">
                    <button
                      onClick={() => selectHandoff(head)}
                      className="min-w-0 flex items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    >
                      <span className="truncate text-[14px] font-bold text-foreground">{head.applicant_name}</span>
                      {multi && (
                        <span
                          className="shrink-0 px-1.5 py-0.5 rounded-full text-[11px] font-bold bg-error-soft text-error-strong"
                          title="이 한 분이 여러 공고에서 넘어왔어요 — 전화는 한 번만 하고 아래에서 공고별로 처리하세요"
                        >
                          공고 {items.length}건
                        </span>
                      )}
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      {head.phone && (
                        <a
                          href={`tel:${head.phone}`}
                          onClick={(e) => e.stopPropagation()}
                          title={`${head.applicant_name}님에게 전화 (${head.phone})`}
                          className="relative flex items-center gap-1 rounded-md text-[12px] font-bold text-info after:absolute after:-inset-2 after:content-[''] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Phone size={12} /> 전화
                        </a>
                      )}
                      <span className={`text-[12px] font-bold ${ageStyle(worstAge)}`}>⏱ {worstAge === 0 ? "오늘" : `${worstAge}일 방치`}</span>
                    </div>
                  </div>
                  {items.map((h) => {
                    const selected = selectedChatId === h.applicant_id && selectedJobId === h.job_id;
                    return (
                      <div
                        key={h.candidate_id}
                        className={`mx-2 mb-2 rounded-lg border transition-colors ${selected ? "border-brand-yellow bg-yellow-50" : "border-muted bg-card hover:border-gray-300"}`}
                      >
                        <button onClick={() => selectHandoff(h)} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full text-left px-2.5 pt-2 pb-1.5 cursor-pointer">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold border ${TONE_STYLE[h.tone]}`}>{h.category_label}</span>
                            {/* 어느 공고 건인지 — 공고가 동시에 여러 개 열리면 지점명만으론 구분되지 않는다. */}
                            {/* 시스템 더미 공고 줄은 지점을 쓰지 않는다 — 큐의 branch에 '지원자 지점'이 섞여 와서
                                공고 자리에 사람 지점명이 찍힌다('공고 미지정' 건이 부천 지점 공고처럼 보였다). */}
                            <span className="text-[11px] font-bold text-gray-700 truncate" title={h.job_title}>
                              {h.is_system_job ? h.job_title : (h.branch && h.branch.trim()) || h.job_title}
                            </span>
                            {multi && <span className={`shrink-0 text-[11px] font-bold ${ageStyle(h.age_days)}`}>{h.age_days === 0 ? "오늘" : `${h.age_days}일`}</span>}
                          </div>
                          {h.reason && <div className="text-[12px] text-gray-700 line-clamp-2 leading-snug">{h.reason}</div>}
                        </button>
                        <div className="flex items-start justify-between gap-2 px-2.5 pb-2 pt-0.5">
                          {/* AI가 적어둔 '다음 행동'이 말줄임 뒤에 숨지 않게 두 줄까지 편다 */}
                          <span className="text-[11px] font-bold text-muted-foreground line-clamp-2 leading-snug">→ {h.suggested_action}</span>
                          <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                            {/* 단가·정책 인계는 매니저 답변을 공고에 반영해 다음부터 AI가 직접 답하게 한다(③-1) */}
                            {!h.is_system_job && ["pay", "contract", "policy"].includes(h.category) && (
                              <Button size="chip" variant="ghost" onClick={() => openPromote(h)} className="px-2.5 bg-yellow-50 text-warning-strong border border-brand-yellow hover:bg-yellow-100 hover:text-warning-strong">공고에 반영</Button>
                            )}
                            {!["manual", "auto"].includes(h.category) && (
                              <Button size="chip" variant="ghost" onClick={() => openKb(h)} className="px-2.5 bg-success-soft text-success-strong border border-success/25 hover:bg-success-soft hover:text-success-strong">지식 등록</Button>
                            )}
                            <Button size="chip" variant="ghost" onClick={() => resumeHandoff(h)} className="px-2.5 bg-info-soft text-info-strong border border-info/25 hover:bg-info-soft hover:text-info-strong">AI 재개</Button>
                            {/* 큐의 출구 — 전화·문자로 해결한 건을 닫는다. AI 재개와 달리 봇을 다시 붙이지 않는다. */}
                            <Button size="chip" variant="ghost" onClick={() => openResolve(h)} className="px-2.5 bg-foreground text-white border border-foreground hover:bg-gray-800 hover:text-white">처리 완료</Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ) : activeTab === "confirm" ? (
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 [&>*]:shrink-0">
            {confirmPending.length === 0 && <div className="text-[13px] text-muted-foreground p-4 text-center">확정 대기 중인 지원자가 없어요</div>}
            {confirmPending.map((p) => {
              const selected = selectedChatId === p.applicant_id;
              return (
                <div key={p.applicant_id} className={`rounded-2xl transition-all ${selected ? "bg-card border border-brand-yellow shadow-sm ring-1 ring-brand-yellow" : "bg-card border border-transparent hover:border-border-strong"}`}>
                  <button onClick={() => setSelectedChatId(p.applicant_id)} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full text-left p-3.5 pb-2 cursor-pointer">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-bold border bg-success-soft text-success-strong border-success/25">온보딩 완료</span>
                      {p.baemin_id && <span className="text-[11px] font-bold text-muted-foreground">ID {p.baemin_id}</span>}
                    </div>
                    <div className="text-[14px] font-bold text-foreground mb-0.5 flex items-center gap-1.5">
                      {p.name}
                      {p.branch && <span className="px-1.5 py-0.5 rounded-full text-[11px] font-bold bg-success-soft text-success-strong">{p.branch}</span>}
                    </div>
                    <div className="text-[12px] text-gray-700 leading-snug line-clamp-2">
                      {p.job_title ?? "공고 미지정"}{p.pickup_address ? ` · ${p.pickup_address}` : ""}
                    </div>
                  </button>
                  {/* 이 큐는 '아직 확정 안 된' 지원자(스크리닝 완료)만 담긴다 — 만남장소·첫날규칙·앱안내는
                      확정 후 콘텐츠라 여기서 보내면 지원자에게 확정 통보로 읽힌다. 그래서 발송 버튼을 두지 않고
                      '확정'만 남긴다. 확정하면 이 큐에서 빠지고, 후속 안내는 지원자 상세의 '확정 후속 안내'에서 보낸다. */}
                  <div className="flex items-center justify-end gap-1.5 px-3.5 pb-2.5 pt-0.5 flex-wrap">
                    <span className="mr-auto text-[11px] text-muted-foreground">확정하면 만남장소·첫날 안내를 보낼 수 있어요</span>
                    <Button size="chip" variant="primary" onClick={() => openConfirmFor(p)} title="확정 — 대상 공고·시작일·지점을 확인하고 확정합니다" className="px-2.5 bg-success-strong hover:bg-success-strong text-white shadow-none focus-visible:ring-success-strong">확정</Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 [&>*]:shrink-0">
          {/* 콜드 로드(데이터 아직 없음)일 때 스켈레톤 카드 — 옛 데이터를 진짜처럼 보여주는 혼동 방지.
              배경 갱신(데이터 있음+isValidating)은 상단 '갱신 중' 표시로만 — 매 주기 전체 스켈레톤은 깜빡여서 안 씀. */}
          {loadingList && (
            <>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="p-3.5 rounded-2xl border border-muted bg-card animate-pulse">
                  <div className="flex items-center gap-2.5 mb-2.5">
                    <div className="w-8 h-8 rounded-lg bg-muted" />
                    <div className="h-3.5 w-24 rounded bg-muted" />
                    <div className="ml-auto h-3 w-10 rounded bg-muted" />
                  </div>
                  <div className="h-3 w-3/4 rounded bg-muted mb-2" />
                  <div className="h-5 w-20 rounded-md bg-muted" />
                </div>
              ))}
            </>
          )}
          {!loadingList && visibleChats.length === 0 && (
            <div className="text-[13px] text-muted-foreground p-4 text-center">
              {search.trim()
                ? "검색 결과가 없어요 — 이름·전화번호를 확인해주세요"
                : "진행 중인 대화가 없어요 — 새 답장이 오면 여기 떠요"}
            </div>
          )}
          {visibleChats.map((chat, idx) => {
            const pal = AVATAR_PALETTE[idx % AVATAR_PALETTE.length];
            const intervention = isUnanswered(chat);
            const pv = previewById[chat.id];
            const turn = whoseTurn(chat, pv);
            // 메타(유입·지점·가용성)는 회색 한 줄로 강등 — 색 배지 경쟁을 없앤다. 수신거부는 turn 배지가 대신 표시.
            const src = chat.source ? SOURCE_LABEL[chat.source] ?? chat.source : null;
            const branch = chat.branch || chat.branch1 || null;
            const availMeta = !chat.sms_opt_out_at && chat.availability ? (chat.availability === "휴면" ? "휴면" : "가능") : null;
            const metaLine = [src, branch, availMeta].filter(Boolean).join(" · ");
            return (
              <button
                key={chat.id}
                onClick={() => setSelectedChatId(chat.id)}
                className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full text-left p-3.5 rounded-2xl transition-all ${selectedChatId === chat.id ? "bg-white border border-brand-yellow shadow-sm ring-1 ring-brand-yellow" : "bg-white border border-transparent hover:border-border-strong"}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm" style={{ backgroundColor: pal.bg, color: pal.fg }}>{chat.name.charAt(0)}</div>
                    <div>
                      <div className="text-[14px] font-bold text-foreground">{chat.name}</div>
                    </div>
                  </div>
                  <div className={`text-[11px] font-semibold ${intervention ? "text-error" : "text-muted-foreground"}`}>{intervention && "⏱ "}{relTime(lastActivityAt(chat))}</div>
                </div>
                {pv?.body ? (
                  <div className="text-[13px] line-clamp-1 mb-2">
                    <span className={`font-bold ${pv.direction === "inbound" ? "text-info" : "text-muted-foreground"}`}>{pv.direction === "inbound" ? "지원자" : pv.manual_outbound ? "매니저" : "발신"}</span>
                    <span className="text-gray-700"> · {pv.body}</span>
                  </div>
                ) : (
                  <div className="text-[13px] text-gray-700 line-clamp-1 mb-2">{chat.status}{chat.agent_stage ? ` · ${STAGE_KO[chat.agent_stage] ?? chat.agent_stage}` : ""}</div>
                )}
                {/* 상태 배지 1개(누구 차례냐) + 회색 메타 한 줄 — 색 배지 경쟁 제거 */}
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-1 rounded-full text-[11px] font-bold shrink-0 ${turn.cls}`}>
                    {turn.label}{turn.sub && <span className="font-semibold opacity-70"> · {turn.sub}</span>}
                  </span>
                  {metaLine && <span className="text-[11px] text-muted-foreground truncate">{metaLine}</span>}
                </div>
              </button>
            );
          })}
        </div>
        )}
      </div>

      {/* Middle Chat Window */}
      {activeChat ? (
        <div className="flex-1 flex flex-col bg-muted min-w-0">
          <div className="min-h-[60px] shrink-0 bg-card border-b border-border-strong px-6 py-2.5 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-lg font-bold text-foreground">{activeChat.name} <span className="text-[16px] text-muted-foreground">지원자</span></div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {activeChat.source && <span className="px-2 py-1 rounded-full text-[11px] font-bold bg-background text-muted-foreground border border-border-strong">{SOURCE_LABEL[activeChat.source] ?? activeChat.source}</span>}
              {(activeChat.branch || activeChat.branch1) && <span className="px-2 py-1 rounded-full text-[11px] font-bold bg-success-soft text-success-strong">{activeChat.branch || activeChat.branch1}</span>}
              {activeChat.agent_stage && <span className={`px-2 py-1 rounded-full text-[11px] font-bold ${activeChat.agent_stage === "paused" ? "bg-muted text-gray-700" : "bg-info-soft text-info-strong"}`}>{STAGE_KO[activeChat.agent_stage] ?? activeChat.agent_stage}</span>}
              <span className="px-2 py-1 rounded-full text-[11px] font-bold bg-yellow-50 text-warning-strong border border-yellow-200">{activeChat.status}</span>
            </div>
          </div>

          {/* 멀티-잡 공고 선택 탭 — 동시에 2개 이상 공고를 진행 중일 때만 노출.
              공고별로 스레드/체크리스트/AI 토글이 분리되어, "어느 공고가 매니저 전환됐는지"가 정확히 보인다. */}
          {activeJobs.length > 1 && (
            <div className="shrink-0 bg-card border-b border-border-strong px-6 py-2 flex items-center gap-2 overflow-x-auto">
              <span className="text-[11px] font-bold text-muted-foreground shrink-0">
                붙어 있는 공고 {activeJobs.length}건 · 탭 전환
                {activeJobs.some((j) => j.agent_stage == null) && (
                  <span className="ml-1 font-medium">(관심만 누른 자리 포함)</span>
                )}
              </span>
              {activeJobs.map((j) => {
                const selected = selectedJobId === j.job_id;
                const paused = j.agent_stage === "paused";
                // 아직 대화가 없는 자리(관심만 누름) — 'AI'로 적으면 응대가 돌고 있다는 거짓 신호가 된다.
                const interestOnly = j.agent_stage == null;
                const label = (j.branch && j.branch.trim()) || j.title;
                return (
                  <button
                    key={j.job_id}
                    onClick={() => setSelectedJobId(j.job_id)}
                    aria-pressed={selected}
                    className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background shrink-0 cursor-pointer px-3 py-1.5 rounded-lg text-[12px] font-bold transition-all flex items-center gap-1.5 active:scale-95 ${
                      selected
                        ? "bg-foreground text-white shadow-sm"
                        : "bg-background border border-border-strong text-gray-700 hover:bg-muted hover:border-gray-300"
                    }`}
                    title={
                      interestOnly
                        ? `${j.title} — 관심만 누른 자리예요(아직 대화 없음). 클릭하면 이 공고로 전환합니다.`
                        : `${j.title} — 클릭해 이 공고 대화로 전환`
                    }
                  >
                    {label}
                    <span
                      className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${
                        interestOnly
                          ? selected ? "bg-yellow-700 text-white" : "bg-yellow-50 text-warning-strong"
                          : paused
                            ? selected ? "bg-gray-700 text-white" : "bg-muted text-gray-700"
                            : selected ? "bg-info text-white" : "bg-info-soft text-info-strong"
                      }`}
                    >
                      {interestOnly ? "관심" : paused ? "수동 응대" : STAGE_KO[j.agent_stage ?? ""] ?? "AI"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* key에 selectedJobId를 넣지 않는다 — 오른쪽 상세 패널이 같은 이유로 이미 뺐다(아래 주석).
              그 값은 /active-jobs 응답이 온 뒤 비동기로 채워지므로, key에 넣으면 사람을 바꿔 누를
              때마다 대화창이 두 번 마운트된다(첫 번째는 버려진다). jobId는 prop으로 반응적으로 읽힌다. */}
          <ConversationThread
            key={activeChat.id}
            applicantId={activeChat.id}
            applicantName={activeChat.name}
            phone={activeChat.phone}
            jobId={selectedJobId}
            globalKill={globalKill}
            copilotMode={copilotMode}
            smsOptOutAt={activeChat.sms_opt_out_at ?? null}
            onChanged={handleChanged}
            className="flex-1 min-h-0"
          />
        </div>
      ) : (
        /* 빈 가운데(1440px 기준 약 1,000px)를 '오늘 요약 + 바로가기'로 채운다.
           첫 대화 자동 선택은 하지 않는다 — 탭 진입만으로 열람 처리되는 부작용(위 주석) 때문.
           대신 '가장 오래 기다린 대화 열기'를 명시적 버튼으로 둔다: 클릭은 의도이므로 열람 처리가 맞다. */
        <div className="flex-1 flex min-w-0 items-center justify-center bg-muted p-6">
          <div className="w-full max-w-md text-center">
            <div className="text-sm font-bold text-muted-foreground mb-4">지금 응대 현황</div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <div className="rounded-2xl border border-border-strong bg-card px-3 py-3">
                <div className="text-[11px] font-bold text-muted-foreground">지금 답할 차례</div>
                <div className="text-[20px] font-extrabold text-foreground leading-tight mt-0.5">{unansweredCount}<span className="text-[12px] font-bold text-muted-foreground ml-0.5">건</span></div>
              </div>
              <div className="rounded-2xl border border-border-strong bg-card px-3 py-3">
                <div className="text-[11px] font-bold text-muted-foreground">사람 확인 필요</div>
                <div className="text-[20px] font-extrabold text-foreground leading-tight mt-0.5">{handoffGroups.length}<span className="text-[12px] font-bold text-muted-foreground ml-0.5">명</span></div>
              </div>
              <div className="rounded-2xl border border-border-strong bg-card px-3 py-3">
                <div className="text-[11px] font-bold text-muted-foreground">확정 대기</div>
                <div className="text-[20px] font-extrabold text-foreground leading-tight mt-0.5">{confirmPending.length}<span className="text-[12px] font-bold text-muted-foreground ml-0.5">명</span></div>
              </div>
            </div>
            {(() => {
              // 가장 오래 기다린 미답 대화 — 명단은 이미 손안에 있다(visibleChats + previewById).
              const waiting = chats
                .filter((c) => previewById[c.id]?.direction === "inbound")
                .sort((a, b) => new Date(lastActivityAt(a) ?? 0).getTime() - new Date(lastActivityAt(b) ?? 0).getTime());
              const oldest = waiting[0];
              if (!oldest) return <div className="text-[13px] text-muted-foreground">지금 답을 기다리는 대화가 없어요 👍</div>;
              const d = Math.max(0, Math.floor((Date.now() - new Date(lastActivityAt(oldest) ?? 0).getTime()) / 86400000));
              return (
                <button
                  onClick={() => setSelectedChatId(oldest.id)}
                  className="w-full rounded-2xl border border-border-strong bg-white px-4 py-3 text-left transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="text-[12px] font-bold text-muted-foreground">가장 오래 기다린 대화 열기</div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-[14px] font-bold text-foreground">{oldest.name}</span>
                    <span className={`shrink-0 text-[12px] font-bold ${d >= 7 ? "text-error-strong" : "text-muted-foreground"}`}>{d === 0 ? "오늘" : `${d}일 대기`}</span>
                  </div>
                </button>
              );
            })()}
          </div>
        </div>
      )}

      {/* Right Sidebar — 통합 지원자 상세(컨텍스트) */}
      {activeChat && (
        <div className="w-[340px] shrink-0 bg-card border-l border-border-strong flex flex-col">
          {/* key에 selectedJobId를 넣지 않는다 — 그 값은 /active-jobs 응답이 온 뒤 비동기로 채워져
              패널을 한 번 더 리마운트시킨다. 큐에서 확정 모달을 열었을 때 그 리마운트가 모달 state를
              날려 '버튼이 씹힌 것처럼' 보이던 경합의 원인이었다. jobId는 prop으로 반응적으로 읽힌다. */}
          <ApplicantDetailContent
            key={activeChat.id}
            applicantId={activeChat.id}
            jobId={selectedJobId}
            variant="panel"
            onChanged={handleChanged}
            autoOpenConfirm={confirmSignal}
            onAutoOpenConfirmConsumed={() => setConfirmSignal(null)}
          />
        </div>
      )}

        {/* 처리 완료 모달 — 결과 3택 + 한 줄 메모. 통화 결과가 타임라인(pool_events)에 남아
          다음 사람이 같은 사람에게 다시 걸거나 아무도 안 거는 일이 없게 한다. */}
      <Modal
        open={Boolean(resolveTarget)}
        onClose={() => setResolveTarget(null)}
        busy={resolveSaving}
        size="sm"
        title={resolveTarget ? `처리 완료 — ${resolveTarget.applicant_name}` : "처리 완료"}
        description="어떻게 해결했는지 남깁니다. AI는 계속 정지 상태로 두고 큐에서만 내보내요."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setResolveTarget(null)} disabled={resolveSaving}>취소</Button>
            <Button size="sm" onClick={submitResolve} isLoading={resolveSaving}>처리 완료로 기록</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <div className="mb-1.5 text-[13px] font-bold text-foreground">어떻게 해결했나요?</div>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="처리 결과">
              {([
                { id: "call", label: "통화로 해결" },
                { id: "sms", label: "문자로 해결" },
                { id: "closed", label: "종결(기타)" },
              ] as const).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={resolveOutcome === o.id}
                  onClick={() => setResolveOutcome(o.id)}
                  className={`min-h-10 rounded-2xl border px-2 text-[13px] font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                    resolveOutcome === o.id
                      ? "border-foreground bg-foreground text-white"
                      : "border-border-strong bg-white text-gray-700 hover:border-foreground/30"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <TextareaField
            label="한 줄 기록"
            hint="예: 화·목 가능하다고 함, 다음 주 공고 나오면 연락 주기로 — 타임라인에 남아요"
            rows={2}
            value={resolveNote}
            onChange={(e) => setResolveNote(e.target.value)}
            placeholder="통화 내용 요약 (선택)"
          />
        </div>
      </Modal>

      {/* 인계 → 자산화(③-1): 매니저 답변을 공고 단가·정책 필드에 반영 */}
      {promote && (
      <Modal bare open={Boolean(promote)} onClose={() => setPromote(null)} size="md"
               title="확정 처리"
        >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border-strong">
              <h2 className="text-[16px] font-extrabold text-foreground">공고에 반영</h2>
              <Button variant="ghost" size="icon" aria-label="공고 반영 창 닫기" onClick={() => setPromote(null)}><X size={20} /></Button>
            </div>
            <div className="p-6 flex flex-col gap-4">
              <div className="text-[13px] text-muted-foreground leading-relaxed">
                <b className="text-gray-700">{promote.job_title}</b> 공고에 반영합니다. 저장하면 다음부터 같은 질문은 AI가 직접 답해서, 매니저가 직접 답해야 하는 일이 줄어듭니다.
              </div>
              <div className="flex gap-1.5">
                <button aria-pressed={promoteField === "pay_info"} onClick={() => setPromoteField("pay_info")} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${promoteField === "pay_info" ? "bg-foreground text-white" : "bg-white border border-border-strong text-muted-foreground"}`}>급여·정산</button>
                <button aria-pressed={promoteField === "policy_notes"} onClick={() => setPromoteField("policy_notes")} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${promoteField === "policy_notes" ? "bg-foreground text-white" : "bg-white border border-border-strong text-muted-foreground"}`}>고용·정책</button>
              </div>
              <textarea
                value={promoteText}
                onChange={(e) => setPromoteText(e.target.value)}
                rows={5}
                disabled={promoteLoading}
                placeholder={promoteLoading ? "불러오는 중…" : promoteField === "pay_info" ? "예: 건당/일당 금액 · 정산 주기(주급/익월5일 등) · 특이사항" : "예: 프리랜서(3.3%) 계약, 4대보험 미적용 · 본인 명의 정산"}
                className="bg-input-background/90 font-medium shadow-inset hover:border-foreground/25 min-h-11 w-full px-4 py-3 border border-border-strong rounded-2xl text-[14px] leading-relaxed focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring resize-none disabled:bg-background"
              />
              <div className="text-[11px] text-muted-foreground">매니저가 직접 보낸 마지막 답변을 미리 채웠어요. 공고에 넣을 표준 문구로 다듬어 저장하세요.</div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border-strong">
              <Button size="chip" variant="ghost" className="px-4 py-2 text-[14px] rounded-lg" onClick={() => setPromote(null)} disabled={promoteSaving}>취소</Button>
              <Button size="chip" variant="primary" className="px-5 py-2 text-[14px] rounded-lg bg-yellow-700 hover:bg-yellow-700 text-white shadow-none focus-visible:ring-yellow-700" onClick={savePromote} disabled={promoteLoading} isLoading={promoteSaving}>{promoteSaving ? "저장 중…" : "공고에 반영"}</Button>
            </div>
        </Modal>
      )}

      {/* 인계 → 지식 자산화(③-2): 매니저 답변을 공통/지점 지식으로 승인 등록 */}
      {kb && (
        <Modal bare open={Boolean(kb)} onClose={() => setKb(null)} size="md"
               title="지식 추가"
        >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border-strong">
              <h2 className="text-[16px] font-extrabold text-foreground">지식 등록</h2>
              <Button variant="ghost" size="icon" aria-label="지식 등록 창 닫기" onClick={() => setKb(null)}><X size={20} /></Button>
            </div>
            <div className="p-6 flex flex-col gap-4">
              <div className="text-[13px] text-muted-foreground leading-relaxed">
                매니저가 검토·승인한 내용만 옹봇 지식이 됩니다. 저장하면 다음부터 같은 질문은 AI가 직접 답해서, 매니저가 직접 답해야 하는 일이 줄어듭니다.
              </div>
              <div className="flex gap-1.5">
                <button aria-pressed={kbTarget === "common"} onClick={() => setKbTarget("common")} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${kbTarget === "common" ? "bg-foreground text-white" : "bg-white border border-border-strong text-muted-foreground"}`}>공통(전 지점)</button>
                <button aria-pressed={kbTarget === "branch"} onClick={() => kb.branch && setKbTarget("branch")} disabled={!kb.branch} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all disabled:opacity-40 ${kbTarget === "branch" ? "bg-foreground text-white" : "bg-white border border-border-strong text-muted-foreground"}`}>{kb.branch ? `${kb.branch} 지점만` : "지점 정보 없음"}</button>
              </div>
              <div>
                <label className="block text-[12px] font-bold text-gray-700 mb-1.5">제목(무슨 질문인가)</label>
                <input
                  value={kbTitle}
                  onChange={(e) => setKbTitle(e.target.value)}
                  placeholder="예: 앱 설치·가입 순서 / 정산 지급일"
                  className="bg-input-background/90 font-medium shadow-inset hover:border-foreground/25 min-h-11 w-full px-4 py-2.5 border border-border-strong rounded-2xl text-[14px] focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div>
                <label className="block text-[12px] font-bold text-gray-700 mb-1.5">내용(AI가 답할 사실)</label>
                <textarea
                  value={kbBody}
                  onChange={(e) => setKbBody(e.target.value)}
                  rows={4}
                  disabled={kbLoading}
                  placeholder={kbLoading ? "불러오는 중…" : "예: 정산은 익월 5일 지급, 유류비는 개인 부담입니다."}
                  className="bg-input-background/90 font-medium shadow-inset hover:border-foreground/25 min-h-11 w-full px-4 py-3 border border-border-strong rounded-2xl text-[14px] leading-relaxed focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring resize-none disabled:bg-background"
                />
              </div>
              <div className="text-[11px] text-muted-foreground">매니저가 직접 보낸 마지막 답변을 미리 채웠어요. 표준 문구로 다듬어 저장하세요.</div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border-strong">
              <Button size="chip" variant="ghost" className="px-4 py-2 text-[14px] rounded-lg" onClick={() => setKb(null)} disabled={kbSaving}>취소</Button>
              <Button size="chip" variant="primary" className="px-5 py-2 text-[14px] rounded-lg bg-success-strong hover:bg-success-strong text-white shadow-none focus-visible:ring-success-strong" onClick={saveKb} disabled={kbLoading} isLoading={kbSaving}>{kbSaving ? "등록 중…" : "지식 등록"}</Button>
            </div>
        </Modal>
      )}

    </div>
  );
}
