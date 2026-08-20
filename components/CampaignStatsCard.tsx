import { useEffect, useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  BellOff,
  ChevronRight,
  History,
  Megaphone,
  RefreshCw,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { campaignCardView, type CampaignCardData, type CampaignStep } from "@/lib/admin/campaign-card-view";

/**
 * 다시 연락 캠페인 현황 카드 (내부 매니저용).
 * 벌크 ping 발송 묶음(최근 N일 ping_sent)의 반응을 단계별 현황 한 줄로 보여준다:
 * 발송 → 열람 → 관심 → 답장 (각 카운트 + 발송 대비 비율).
 * '관심'·'답장'은 아래 처리 큐 카드(#interest-queue/#reply-queue)로 앵커 스크롤해 바로 동선을 잇고,
 * '발송'·'열람'은 사람 명단이 있는 파이프라인 캠페인 단계별 현황 보드(/pipeline?view=funnel)로 이동한다.
 * 로딩·오류·실제 무발송·최근 캠페인·지난 캠페인을 서로 다른 상태로 보여 집계 신뢰도를 숨기지 않는다.
 * ⚠️ 확정은 매니저가 처리한 결과만 뜻한다. 관심·답장으로 자동 확정되지 않는다.
 */

function agoLabel(iso: string | null, now: number): string {
  if (!iso) return "-";
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

// '#앵커' 카드로 스크롤 — 대시보드 '오늘의 할 일'과 동일 동선. 감속 설정에서는 즉시 이동한다.
const scrollToAnchor = (id: string) => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
};

const STEP_META: Record<CampaignStep["key"], { label: string; anchor: string | null }> = {
  sent: { label: "발송 인원", anchor: null },
  viewed: { label: "열람", anchor: null },
  interested: { label: "관심", anchor: "interest-queue" },
  replied: { label: "답장", anchor: "reply-queue" },
  confirmed: { label: "매니저 확정", anchor: null },
};

export function CampaignStatsCard() {
  const router = useRouter();
  const { data, error, mutate, isValidating } = useSWR<CampaignCardData>("/api/admin/campaign-stats", { refreshInterval: 60_000 }); // 살아있는 갱신 — 반응이 실시간으로 반영

  // '마지막 발송 상대시각' 갱신용 1분 틱 (InterestQueueCard와 동일 패턴)
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const view = campaignCardView({ data, error });
  const refreshButton = (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => void mutate()}
      disabled={isValidating}
      aria-busy={isValidating || undefined}
      className="motion-reduce:transition-none"
    >
      <RefreshCw
        aria-hidden="true"
        className={isValidating ? "animate-spin motion-reduce:animate-none" : ""}
      />
      {isValidating ? "갱신 중" : "새로고침"}
    </Button>
  );

  if (view.state === "loading") {
    return (
      <section
        aria-labelledby="campaign-card-loading-title"
        aria-busy="true"
        className="rounded-2xl border border-border-strong bg-card p-5 shadow-sm sm:p-6"
      >
        <div className="flex items-center gap-2 text-foreground">
          <Megaphone aria-hidden="true" className="size-4 text-warning-strong" />
          <h2 id="campaign-card-loading-title" className="text-[16px] font-bold">다시 연락 캠페인</h2>
        </div>
        <p role="status" className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          발송 인원과 반응 집계 기준을 확인하고 있어요.
        </p>
        <div aria-hidden="true" className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[0, 1, 2, 3, 4].map((item) => (
            <div key={item} className="h-[92px] animate-pulse rounded-2xl border border-border bg-muted/60 motion-reduce:animate-none" />
          ))}
        </div>
      </section>
    );
  }

  if (view.state === "error") {
    return (
      <section
        role="alert"
        aria-labelledby="campaign-card-error-title"
        className="flex flex-col gap-4 rounded-2xl border border-error/30 bg-error-soft p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-error/20 bg-card text-error-strong">
            <AlertTriangle aria-hidden="true" className="size-5" />
          </span>
          <div>
            <h2 id="campaign-card-error-title" className="text-[16px] font-bold text-foreground">캠페인 현황을 불러오지 못했어요</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-error-strong">
              실패한 집계를 0명으로 표시하지 않았습니다. 연결을 확인한 뒤 다시 시도해 주세요.
            </p>
          </div>
        </div>
        {refreshButton}
      </section>
    );
  }

  if (view.state === "empty") {
    return (
      <section
        aria-labelledby="campaign-card-empty-title"
        className="flex flex-col gap-4 rounded-2xl border border-dashed border-border-strong bg-card p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border-strong bg-background text-muted-foreground">
            <Megaphone aria-hidden="true" className="size-5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="campaign-card-empty-title" className="text-[16px] font-bold text-foreground">다시 연락 캠페인</h2>
              <span className="rounded-full border border-border-strong bg-background px-2 py-0.5 text-[12px] font-bold text-muted-foreground">집계 완료</span>
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-foreground">
              최근 {view.windowDays}일 동안 다시 연락 문자를 받은 인원이 없습니다.
            </p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
              발송 인원 0명은 로딩이나 오류가 아닌 실제 집계 결과예요.
            </p>
          </div>
        </div>
        {refreshButton}
      </section>
    );
  }

  const stats = view.data;
  const isStale = view.state === "stale";

  return (
    <section
      aria-labelledby="campaign-card-title"
      className="flex flex-col rounded-2xl border border-border-strong bg-card p-5 shadow-sm sm:p-6"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`flex size-8 items-center justify-center rounded-full border ${isStale ? "border-warning/25 bg-warning-soft text-warning-strong" : "border-brand-yellow/70 bg-brand-muted text-foreground"}`}>
              {isStale ? <History aria-hidden="true" className="size-4" /> : <Megaphone aria-hidden="true" className="size-4" />}
            </span>
            <h2 id="campaign-card-title" className="text-[16px] font-bold text-foreground">다시 연락 캠페인</h2>
            <span className={`rounded-full border px-2 py-0.5 text-[12px] font-bold ${isStale ? "border-warning/30 bg-warning-soft text-warning-strong" : "border-border-strong bg-background text-muted-foreground"}`}>
              {isStale ? "지난 캠페인" : `최근 ${stats.window_days}일`}
            </span>
          </div>
          <p id="campaign-period-note" className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
            {isStale
              ? `최근 ${stats.window_days}일 내 발송이 없어 마지막 캠페인을 포함하는 과거 ${stats.window_days}일 구간을 보여줍니다.`
              : `최근 ${stats.window_days}일 안에 다시 연락 문자를 받은 사람과 첫 발송 이후 반응을 집계합니다.`}
          </p>
          <p className="mt-1 text-[12px] font-medium text-foreground">
            마지막 발송 {agoLabel(stats.last_sent_at, nowTick)}
            <span aria-hidden="true" className="px-1.5 text-muted-foreground">·</span>
            문자 기록 {stats.sent_messages.toLocaleString("ko-KR")}건
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {refreshButton}
          <span aria-live="polite" className="text-[12px] text-muted-foreground">
            {isValidating ? "최신 집계를 확인하는 중" : "60초마다 자동 갱신"}
          </span>
        </div>
      </header>

      {isStale && (
        <div role="note" className="mt-4 flex items-start gap-2 rounded-2xl border border-warning/25 bg-warning-soft px-3.5 py-3 text-[12px] leading-relaxed text-warning-strong">
          <History aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          현재 캠페인 성과가 아닙니다. 마지막 발송 시점의 과거 결과로 다음 발송 판단에 참고만 해 주세요.
        </div>
      )}

      {/* 단계별 현황 한 줄 — 각 단계 카운트 + 발송 대비 비율. 관심/답장은 처리 큐 카드로 앵커 이동. */}
      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {view.steps.map((step) => {
          const meta = STEP_META[step.key];
          const managerControlled = step.confirmationSource === "manager";
          const label = managerControlled ? "매니저 확정" : meta.label;
          const destination = meta.anchor ? `${label} 처리 큐` : "캠페인 단계별 사람 명단";
          return (
            <button
              key={step.key}
              type="button"
              onClick={() => (meta.anchor ? scrollToAnchor(meta.anchor) : router.push("/pipeline?view=funnel"))}
              aria-label={`${label} ${step.count}명${step.percent === null ? "" : `, 발송 인원 대비 ${step.percent}%`}. ${destination}으로 이동`}
              aria-describedby={step.percent === null ? "campaign-period-note" : "campaign-rate-basis"}
              className={`group relative min-h-[104px] rounded-2xl border px-4 py-3 text-left outline-none transition-[background-color,border-color,box-shadow] hover:border-foreground/30 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${managerControlled ? "border-brand-yellow/70 bg-brand-muted/45" : "border-border-strong bg-background"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-bold text-muted-foreground">{label}</span>
                <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none" />
              </div>
              <div className="mt-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                <span className="text-[24px] font-extrabold leading-none tracking-tight text-foreground tabular-nums">{step.count.toLocaleString("ko-KR")}</span>
                <span className="text-[12px] font-bold text-muted-foreground">명</span>
                {step.percent !== null && (
                  <span className="rounded-full border border-border bg-card px-1.5 py-0.5 text-[12px] font-bold text-foreground tabular-nums">
                    {step.percent}%
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        <div id="campaign-rate-basis" className="flex items-start gap-2 rounded-2xl border border-border bg-background px-3.5 py-3 text-[12px] leading-relaxed text-muted-foreground">
          <Users aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-foreground" />
          <span>
            모든 비율의 분모는 문자 {stats.sent_messages.toLocaleString("ko-KR")}건이 아니라 발송 인원 <strong className="text-foreground">{view.denominator.count.toLocaleString("ko-KR")}명</strong>입니다. 같은 사람의 중복 발송은 한 명으로 셉니다.
          </span>
        </div>
        <div className="flex items-start gap-2 rounded-2xl border border-brand-yellow/50 bg-brand-muted/45 px-3.5 py-3 text-[12px] leading-relaxed text-foreground">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>매니저 확정</strong>은 캠페인 첫 발송 뒤 매니저가 직접 확정 처리한 인원만 셉니다. 관심이나 답장만으로 근무가 자동 확정되지는 않습니다.
          </span>
        </div>
      </div>

      {/* 하단: 공고별 관심 분해 칩 + 실패/수신거부 (있을 때만) */}
      {(stats.by_job.length > 0 || stats.failed > 0 || stats.opted_out > 0) && (
        <footer className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          {stats.by_job.length > 0 && (
            <>
              <span className="shrink-0 text-[12px] font-bold text-muted-foreground">공고별 관심</span>
              {stats.by_job.map((job) => (
                <button
                  key={job.job_id}
                  type="button"
                  onClick={() => scrollToAnchor("interest-queue")}
                  aria-label={`${job.title}, 관심 ${job.count}명${job.immediate_count > 0 ? `, 즉시가능 ${job.immediate_count}명` : ""}. 관심 처리 큐로 이동`}
                  className="flex min-h-10 items-center gap-1.5 rounded-full border border-border-strong bg-background px-3 text-[12px] font-bold text-foreground outline-none transition-colors hover:border-foreground/30 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                >
                  <span className="text-muted-foreground">#{job.job_id}</span>
                  <span className="max-w-[160px] truncate">{job.title}</span>
                  <span>{job.count.toLocaleString("ko-KR")}명</span>
                  {job.immediate_count > 0 && (
                    <span className="flex items-center gap-0.5 text-success-strong">
                      <span aria-hidden="true">·</span>
                      <Zap aria-hidden="true" className="size-3" />
                      {job.immediate_count.toLocaleString("ko-KR")} 즉시가능
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
          {(stats.failed > 0 || stats.opted_out > 0) && (
            <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2 text-[12px]">
              {stats.failed > 0 && (
                <span className="flex min-h-8 items-center gap-1.5 rounded-full border border-error/25 bg-error-soft px-2.5 font-bold text-error-strong">
                  <AlertTriangle aria-hidden="true" className="size-3.5" />
                  문자 기록 {stats.sent_messages.toLocaleString("ko-KR")}건 중 실패 {stats.failed.toLocaleString("ko-KR")}건
                </span>
              )}
              {stats.opted_out > 0 && (
                <span className="flex min-h-8 items-center gap-1.5 rounded-full border border-border-strong bg-background px-2.5 font-bold text-foreground">
                  <BellOff aria-hidden="true" className="size-3.5" />
                  수신거부 {stats.opted_out.toLocaleString("ko-KR")}명
                </span>
              )}
            </div>
          )}
        </footer>
      )}
    </section>
  );
}
