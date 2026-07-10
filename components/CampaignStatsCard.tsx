import { Fragment, useEffect, useState } from "react";
import useSWR from "swr";
import { motion } from "motion/react";
import { ChevronRight, Megaphone, RefreshCw, Zap } from "lucide-react";

/**
 * 재컨택 캠페인 현황 카드 (내부 매니저용).
 * 벌크 ping 발송 코호트(최근 N일 ping_sent)의 반응을 퍼널 한 줄로 보여준다:
 * 발송 → 열람 → 관심 → 답장 (각 카운트 + 발송 대비 비율).
 * '관심'·'답장'은 아래 처리 큐 카드(#interest-queue/#reply-queue)로 앵커 스크롤해 바로 동선을 잇는다.
 * 발송 이력이 없으면(코호트 0) 카드 자체를 숨긴다. 카드 톤은 InterestQueueCard와 일관.
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
  last_sent_at: string | null;
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
  const { data, error, mutate, isValidating } = useSWR<CampaignStatsRes>("/api/admin/campaign-stats");

  // '마지막 발송 상대시각' 갱신용 1분 틱 (InterestQueueCard와 동일 패턴)
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // 발송 이력이 없으면(또는 로딩/오류) 카드 숨김 — 캠페인이 없는 날 대시보드를 차지하지 않는다.
  if (error || !data || data.sent === 0) return null;

  const pctOfSent = (n: number) => (data.sent ? Math.round((n / data.sent) * 100) : 0);
  const steps: { key: string; label: string; value: number; pct: number | null; anchor: string | null }[] = [
    { key: "sent", label: "발송", value: data.sent, pct: null, anchor: null },
    { key: "viewed", label: "열람", value: data.viewed, pct: pctOfSent(data.viewed), anchor: null },
    { key: "interested", label: "관심", value: data.interested, pct: pctOfSent(data.interested), anchor: "interest-queue" },
    { key: "replied", label: "답장", value: data.replied, pct: pctOfSent(data.replied), anchor: "reply-queue" },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.35 }}
      className="bg-white border border-[#E2E8F0] rounded-[16px] p-6 shadow-sm flex flex-col"
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-[15px] font-bold text-[#1A202C] flex items-center gap-1.5">
            <Megaphone size={15} className="text-[#3182CE]" /> 재컨택 캠페인 (최근 {data.window_days}일)
          </h2>
          <div className="text-[12px] text-[#718096] mt-0.5">
            발송 코호트 {data.sent}명의 반응 현황
            <span className="text-[#CBD5E0]"> · </span>
            마지막 발송 {agoLabel(data.last_sent_at, nowTick)}
            <span className="text-[#CBD5E0]"> · </span>
            문자 {data.sent_messages}건
          </div>
        </div>
        <button
          onClick={() => void mutate()}
          title="집계 새로고침"
          className="flex items-center gap-1 text-[11.5px] font-bold text-[#4A5568] bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] px-3 py-1.5 rounded-lg shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
        >
          <RefreshCw size={13} className={isValidating ? "animate-spin" : ""} /> 새로고침
        </button>
      </div>

      {/* 퍼널 한 줄 — 각 단계 카운트 + 발송 대비 비율. 관심/답장은 처리 큐 카드로 앵커 이동. */}
      <div className="flex items-stretch gap-2">
        {steps.map((s, i) => {
          const inner = (
            <>
              <div className="text-[11px] font-bold text-[#718096]">{s.label}</div>
              <div className="flex items-baseline gap-1.5 mt-0.5">
                <span className="text-[20px] font-extrabold text-[#1A202C] leading-none tracking-tight">{s.value}</span>
                <span className="text-[11px] text-[#A0AEC0] font-bold">명</span>
                {s.pct !== null && (
                  <span className="text-[10.5px] font-bold text-[#718096] bg-[#EDF2F7] px-1.5 py-0.5 rounded">{s.pct}%</span>
                )}
              </div>
            </>
          );
          return (
            <Fragment key={s.key}>
              {i > 0 && <ChevronRight size={14} className="text-[#CBD5E0] shrink-0 self-center" />}
              {s.anchor ? (
                <button
                  onClick={() => scrollToAnchor(s.anchor!)}
                  title={`${s.label} 처리 큐로 이동`}
                  className="flex-1 text-left rounded-xl border border-[#E2E8F0] bg-[#F7FAFC] px-4 py-3 hover:border-[#90CDF4] hover:bg-[#EBF8FF] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
                >
                  {inner}
                </button>
              ) : (
                <div className="flex-1 rounded-xl border border-[#E2E8F0] bg-[#F7FAFC] px-4 py-3">{inner}</div>
              )}
            </Fragment>
          );
        })}
      </div>

      {/* 하단: 공고별 관심 분해 칩 + 실패/수신거부 (있을 때만) */}
      {(data.by_job.length > 0 || data.failed > 0 || data.opted_out > 0) && (
        <div className="mt-4 pt-3 border-t border-[#F1F4F8] flex items-center gap-2 flex-wrap">
          {data.by_job.length > 0 && (
            <>
              <span className="text-[11px] font-bold text-[#A0AEC0] shrink-0">공고별 관심</span>
              {data.by_job.map((j) => (
                <button
                  key={j.job_id}
                  onClick={() => scrollToAnchor("interest-queue")}
                  title={`${j.title} — 관심 표시 처리 큐로 이동`}
                  className="flex items-center gap-1 text-[11.5px] font-bold text-[#4A5568] bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] hover:border-[#90CDF4] px-2.5 py-1 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
                >
                  <span className="text-[#A0AEC0]">#{j.job_id}</span>
                  <span className="max-w-[160px] truncate">{j.title}</span>
                  <span className="text-[#3182CE]">{j.count}</span>
                  {j.immediate_count > 0 && (
                    <span className="flex items-center gap-0.5 text-[#276749]">
                      · <Zap size={11} /> {j.immediate_count}
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
          {(data.failed > 0 || data.opted_out > 0) && (
            <span className="ml-auto flex items-center gap-3 shrink-0 text-[11.5px]">
              {data.failed > 0 && <span className="font-semibold text-[#A0AEC0]">발송 실패 {data.failed}건</span>}
              {data.opted_out > 0 && <span className="font-bold text-[#E53E3E]">수신거부 {data.opted_out}명</span>}
            </span>
          )}
        </div>
      )}
    </motion.div>
  );
}
