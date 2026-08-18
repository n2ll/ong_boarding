import { Fragment, useEffect, useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { ChevronRight, Megaphone, RefreshCw, Zap } from "lucide-react";

/**
 * 다시 연락 캠페인 현황 카드 (내부 매니저용).
 * 벌크 ping 발송 묶음(최근 N일 ping_sent)의 반응을 단계별 현황 한 줄로 보여준다:
 * 발송 → 열람 → 관심 → 답장 (각 카운트 + 발송 대비 비율).
 * '관심'·'답장'은 아래 처리 큐 카드(#interest-queue/#reply-queue)로 앵커 스크롤해 바로 동선을 잇고,
 * '발송'·'열람'은 사람 명단이 있는 파이프라인 캠페인 단계별 현황 보드(/pipeline?view=funnel)로 이동한다.
 * 발송 이력이 없으면(발송 묶음 0) 카드 자체를 숨긴다. 카드 톤은 InterestQueueCard와 일관.
 */

interface ByJob {
  job_id: number;
  title: string;
  count: number;
  immediate_count: number;
}

interface CampaignStatsRes {
  window_days: number;
  sent: number;
  sent_messages: number;
  failed: number;
  viewed: number;
  interested: number;
  by_job: ByJob[];
  replied: number;
  opted_out: number;
  confirmed: number;
  last_sent_at: string | null;
  /** true = 최근 창에 발송이 없어 마지막 캠페인에 창을 다시 건 상태(지난 캠페인 표시 중) */
  stale: boolean;
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

// '#앵커' 카드로 스크롤 — 대시보드 '오늘의 할 일'과 동일 동선
const scrollToAnchor = (id: string) =>
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

export function CampaignStatsCard() {
  const router = useRouter();
  const { data, error, mutate, isValidating } = useSWR<CampaignStatsRes>("/api/admin/campaign-stats", { refreshInterval: 60_000 }); // 살아있는 갱신 — 반응이 실시간으로 반영

  // '마지막 발송 상대시각' 갱신용 1분 틱 (InterestQueueCard와 동일 패턴)
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // 발송 이력이 아예 없으면(또는 로딩/오류) 카드 숨김. 최근 창에 없더라도 지난 캠페인이
  // 있으면 서버가 그쪽으로 창을 옮겨 보내준다(stale) — 지난 성과를 판단할 근거는 남긴다.
  if (error || !data || data.sent === 0) return null;

  const pctOfSent = (n: number) => (data.sent ? Math.round((n / data.sent) * 100) : 0);
  const steps: { key: string; label: string; value: number; pct: number | null; anchor: string | null }[] = [
    { key: "sent", label: "발송", value: data.sent, pct: null, anchor: null },
    { key: "viewed", label: "열람", value: data.viewed, pct: pctOfSent(data.viewed), anchor: null },
    { key: "interested", label: "관심", value: data.interested, pct: pctOfSent(data.interested), anchor: "interest-queue" },
    { key: "replied", label: "답장", value: data.replied, pct: pctOfSent(data.replied), anchor: "reply-queue" },
    // 퍼널의 마지막 칸 — 이 칸이 0이면 "반응은 좋았는데 확정이 안 됐다"는 뜻이다.
    // 관심·답장만 보고 "캠페인을 더 돌리자"로 가지 않게, 실제 결과를 같은 줄에서 말한다.
    { key: "confirmed", label: "확정", value: data.confirmed, pct: pctOfSent(data.confirmed), anchor: null },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.35 }}
      className="bg-card border border-border-strong rounded-2xl p-6 shadow-sm flex flex-col"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-[16px] font-bold text-foreground flex items-center gap-1.5">
            <Megaphone size={15} className="text-info" /> 다시 연락 캠페인 {data.stale ? "(지난 캠페인)" : `(최근 ${data.window_days}일)`}
          </h2>
          <div className="text-[12px] text-muted-foreground mt-0.5" title={`발송 묶음 — 최근 ${data.window_days}일 안에 다시 연락 문자를 받은 인원 묶음`}>
            발송 묶음 {data.sent}명의 반응 현황
            <span className="text-muted-foreground"> · </span>
            마지막 발송 {agoLabel(data.last_sent_at, nowTick)}
            <span className="text-muted-foreground"> · </span>
            문자 {data.sent_messages}건
          </div>
        </div>
        <button
          onClick={() => void mutate()}
          title="집계 새로고침"
          className="flex items-center gap-1 text-[12px] font-bold text-gray-700 bg-white border border-border-strong hover:bg-background px-3 py-1.5 rounded-lg shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw size={13} className={isValidating ? "animate-spin" : ""} /> 새로고침
        </button>
      </div>

      {/* 단계별 현황 한 줄 — 각 단계 카운트 + 발송 대비 비율. 관심/답장은 처리 큐 카드로 앵커 이동. */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:items-stretch">
        {steps.map((s, i) => {
          const inner = (
            <>
              <div className="text-[11px] font-bold text-muted-foreground">{s.label}</div>
              <div className="flex items-baseline gap-1.5 mt-0.5">
                <span className="text-[20px] font-extrabold text-foreground leading-none tracking-tight">{s.value}</span>
                <span className="text-[11px] text-muted-foreground font-bold">명</span>
                {s.pct !== null && (
                  <span className="text-[11px] font-bold text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">{s.pct}%</span>
                )}
              </div>
            </>
          );
          return (
            <Fragment key={s.key}>
              {i > 0 && <ChevronRight size={14} className="text-muted-foreground shrink-0 self-center" />}
              <button
                onClick={() => (s.anchor ? scrollToAnchor(s.anchor) : router.push("/pipeline?view=funnel"))}
                title={s.anchor ? `${s.label === "답장" ? "내가 답할 차례" : s.label} 처리 큐로 이동` : "캠페인 단계별 현황(사람 명단)으로 이동"}
                className="flex-1 text-left rounded-2xl border border-border-strong bg-background px-4 py-3 hover:border-info/60 hover:bg-info-soft transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {inner}
              </button>
            </Fragment>
          );
        })}
      </div>

      {/* 하단: 공고별 관심 분해 칩 + 실패/수신거부 (있을 때만) */}
      {(data.by_job.length > 0 || data.failed > 0 || data.opted_out > 0) && (
        <div className="mt-4 pt-3 border-t border-muted flex items-center gap-2 flex-wrap">
          {data.by_job.length > 0 && (
            <>
              <span className="text-[11px] font-bold text-muted-foreground shrink-0">공고별 관심</span>
              {data.by_job.map((j) => (
                <button
                  key={j.job_id}
                  onClick={() => scrollToAnchor("interest-queue")}
                  title={`${j.title} — 관심 표시 처리 큐로 이동`}
                  className="flex items-center gap-1 text-[12px] font-bold text-gray-700 bg-white border border-border-strong hover:bg-background hover:border-info/60 px-2.5 py-1 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="text-muted-foreground">#{j.job_id}</span>
                  <span className="max-w-[160px] truncate">{j.title}</span>
                  <span className="text-info">{j.count}</span>
                  {j.immediate_count > 0 && (
                    <span className="flex items-center gap-0.5 text-success-strong">
                      · <Zap size={11} /> {j.immediate_count}
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
          {(data.failed > 0 || data.opted_out > 0) && (
            <span className="ml-auto flex items-center gap-3 shrink-0 text-[12px]">
              {data.failed > 0 && <span className="font-semibold text-muted-foreground">발송 실패 {data.failed}건</span>}
              {data.opted_out > 0 && <span className="font-bold text-error">수신거부 {data.opted_out}명</span>}
            </span>
          )}
        </div>
      )}
    </motion.div>
  );
}
