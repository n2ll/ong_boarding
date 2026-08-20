"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Coins,
  Download,
  RefreshCw,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Slottable } from "@radix-ui/react-slot";

import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/ui/page-shell";
import {
  reportOverview,
  type ReportApplicantRow,
  type ReportOverview,
  type ReportRange,
  type ReportStageKey,
  type ReportUsageRow,
} from "@/lib/admin/report-overview";

const RANGES: ReportRange[] = ["이번 주", "이번 달", "올해"];

const STAGE_LABELS: Record<ReportStageKey, string> = {
  received: "스크리닝 전",
  screening: "스크리닝 중",
  review: "스크리닝 완료",
  confirmed: "매니저 확정",
  other: "대기·종료·기타",
};

const SOURCE_LABELS = {
  applicants: "지원자 집계",
  usage: "비용 집계",
} as const;

interface KpiCardProps {
  icon: typeof Users;
  label: string;
  value: number;
  unit: string;
  description: string;
  href: string;
  action: string;
  emphasis?: boolean;
}

function KpiCard({ icon: Icon, label, value, unit, description, href, action, emphasis = false }: KpiCardProps) {
  return (
    <article className={`flex min-h-[190px] flex-col rounded-3xl border p-5 shadow-sm ${emphasis ? "border-warning/35 bg-brand-muted" : "border-border-strong bg-card"}`}>
      <div className="flex items-start justify-between gap-4">
        <div className={`flex size-10 items-center justify-center rounded-2xl ${emphasis ? "bg-brand-yellow text-foreground" : "bg-muted text-foreground"}`}>
          <Icon aria-hidden="true" size={20} />
        </div>
        {emphasis ? (
          <span className="rounded-full border border-warning/30 bg-card px-2.5 py-1 text-xs font-extrabold text-warning-strong">
            우선 검토
          </span>
        ) : null}
      </div>
      <p className="mt-4 text-sm font-bold text-muted-foreground">{label}</p>
      <p className="mt-1 text-[28px] font-extrabold tracking-tight text-foreground">
        {value.toLocaleString()}
        <span className="ml-1 text-sm font-semibold text-muted-foreground">{unit}</span>
      </p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      <Link
        href={href}
        className="mt-auto inline-flex min-h-11 items-center gap-1 self-start rounded-xl pt-3 text-sm font-extrabold text-foreground outline-none hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {action}
        <ArrowRight aria-hidden="true" size={15} />
      </Link>
    </article>
  );
}

function ReportLoading() {
  return (
    <div role="status" aria-live="polite" aria-label="리포트 데이터를 불러오는 중" className="space-y-6">
      <span className="sr-only">지원자와 비용 데이터를 불러오고 있습니다.</span>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-[190px] animate-pulse rounded-3xl border border-border-strong bg-card p-5 motion-reduce:animate-none">
            <div className="size-10 rounded-2xl bg-muted" />
            <div className="mt-5 h-4 w-24 rounded bg-muted" />
            <div className="mt-3 h-8 w-20 rounded bg-muted" />
            <div className="mt-4 h-4 w-3/4 rounded bg-muted" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
        <div className="h-[410px] animate-pulse rounded-3xl border border-border-strong bg-card motion-reduce:animate-none" />
        <div className="h-[410px] animate-pulse rounded-3xl border border-border-strong bg-card motion-reduce:animate-none" />
      </div>
    </div>
  );
}

function percentOf(value: number, total: number): string {
  return total === 0 ? "0%" : `${Math.round((value / total) * 100)}%`;
}

export function Reports() {
  const [dateRange, setDateRange] = useState<ReportRange>("올해");
  const now = useMemo(() => new Date(), []);
  const {
    data: applicantsResponse,
    error: applicantsError,
    isValidating: applicantsValidating,
    mutate: mutateApplicants,
  } = useSWR<{ data?: ReportApplicantRow[] }>("/api/admin/applicants?scope=rollup");
  const {
    data: usageResponse,
    error: usageError,
    isValidating: usageValidating,
    mutate: mutateUsage,
  } = useSWR<{ data?: ReportUsageRow[] }>("/api/admin/usage");

  const overview = useMemo(() => reportOverview({
    applicants: applicantsResponse?.data,
    usage: usageResponse?.data,
    errors: { applicants: applicantsError, usage: usageError },
    range: dateRange,
    now,
  }), [applicantsError, applicantsResponse, dateRange, now, usageError, usageResponse]);

  const retry = useCallback(async () => {
    await Promise.all([mutateApplicants(), mutateUsage()]);
  }, [mutateApplicants, mutateUsage]);

  const handleDownload = useCallback(() => {
    if (overview.state !== "ready") return;
    const rows: (string | number)[][] = [
      ["지원자 등록 기간", `${dateRange} (한국시간)`],
      ["지원자 집계 기준", "등록 시각 · 일괄 임포트 제외"],
      ["비용 집계 기간", "최근 30일"],
      [],
      ["항목", "값"],
      ["기간 내 등록 지원자(명)", overview.total],
      ["스크리닝 중(명)", overview.screening],
      ["스크리닝 완료(명)", overview.reviewReady],
      ["매니저 확정(명)", overview.confirmed],
      ["최근 30일 누적 비용(원)", Math.round(overview.costLast30Days)],
      ["제외한 일괄 임포트(명)", overview.excludedImports],
      [],
      ["현재 상태", "인원"],
      ...overview.stages.map((stage) => [STAGE_LABELS[stage.key], stage.count] as (string | number)[]),
    ];
    const escapeCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const csv = rows.map((row) => row.map(escapeCell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `리포트_${dateRange}_${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("현재 기준의 리포트를 CSV로 내보냈어요.");
  }, [dateRange, overview]);

  const refreshing = applicantsValidating || usageValidating;

  return (
    <PageShell>
      <section aria-labelledby="report-scope-heading" className="rounded-3xl border border-border-strong bg-card p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 text-sm font-extrabold text-warning-strong">
              <CalendarDays aria-hidden="true" size={17} />
              운영 지표 기준
            </div>
            <h1 id="report-scope-heading" className="mt-2 text-xl font-extrabold tracking-tight text-foreground sm:text-2xl">
              등록 흐름과 매니저 검토 대상을 함께 봅니다
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              지원자 수는 선택한 등록 기간의 유효한 등록 시각을 기준으로 집계하고, 일괄 임포트는 제외합니다. 비용은 선택 기간과 별개로 최근 30일 기준입니다.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div>
              <p id="report-range-label" className="mb-1.5 text-xs font-extrabold text-muted-foreground">지원자 등록 기간 · 한국시간</p>
              <div role="group" aria-labelledby="report-range-label" className="inline-flex rounded-2xl border border-border-strong bg-background p-1">
                {RANGES.map((range) => (
                  <Button
                    key={range}
                    type="button"
                    size="sm"
                    variant={dateRange === range ? "brand" : "ghost"}
                    aria-pressed={dateRange === range}
                    onClick={() => setDateRange(range)}
                    className="shadow-none"
                  >
                    {range}
                  </Button>
                ))}
              </div>
            </div>
            <Button type="button" variant="secondary" onClick={handleDownload} disabled={overview.state !== "ready"}>
              <Download aria-hidden="true" size={16} />
              CSV 다운로드
            </Button>
          </div>
        </div>
      </section>

      {overview.state === "error" ? (
        <section role="alert" className="flex flex-col gap-4 rounded-3xl border border-error/30 bg-error-soft p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0 text-error-strong" size={20} />
            <div>
              <h2 className="text-base font-extrabold text-error-strong">리포트를 완성하지 못했습니다</h2>
              <p className="mt-1 text-sm leading-6 text-error-strong">
                {overview.failed.map((source) => SOURCE_LABELS[source]).join(", ")}을 불러오지 못했습니다. 일부 숫자를 0으로 대신 표시하지 않았습니다.
              </p>
            </div>
          </div>
          <Button type="button" variant="secondary" onClick={retry} isLoading={refreshing}>
            <RefreshCw aria-hidden="true" size={16} />
            다시 불러오기
          </Button>
        </section>
      ) : overview.state === "loading" ? (
        <ReportLoading />
      ) : (
        <ReadyReport dateRange={dateRange} overview={overview} />
      )}
    </PageShell>
  );
}

function ReadyReport({ dateRange, overview }: { dateRange: ReportRange; overview: Extract<ReportOverview, { state: "ready" }> }) {
  const trendData = overview.trend.map((month) => ({
    name: month.month.replace("-", "."),
    지원자: month.applicants,
    "매니저 확정": month.confirmed,
  }));
  const stageData = overview.stages.map((stage) => ({
    key: stage.key,
    name: STAGE_LABELS[stage.key],
    인원: stage.count,
  }));

  return (
    <>
      <section aria-labelledby="report-kpi-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="report-kpi-heading" className="text-lg font-extrabold text-foreground">지금 판단할 인원</h2>
            <p className="mt-1 text-sm text-muted-foreground">{dateRange} 등록 {overview.total.toLocaleString()}명을 현재 상태로 나눈 값입니다.</p>
          </div>
          {overview.excludedImports > 0 ? (
            <span className="rounded-full border border-border-strong bg-card px-3 py-1.5 text-xs font-bold text-muted-foreground">
              일괄 임포트 {overview.excludedImports.toLocaleString()}명 제외
            </span>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            icon={ClipboardCheck}
            label="스크리닝 완료"
            value={overview.reviewReady}
            unit="명"
            description={`매니저 판단을 기다리는 현재 인원 · 전체의 ${percentOf(overview.reviewReady, overview.total)}`}
            href="/pipeline?status=스크리닝%20완료"
            action="인재풀 전체 검토 대상"
            emphasis
          />
          <KpiCard
            icon={Brain}
            label="스크리닝 중"
            value={overview.screening}
            unit="명"
            description={`AI가 정보를 확인 중인 현재 인원 · 전체의 ${percentOf(overview.screening, overview.total)}`}
            href="/pipeline?status=스크리닝%20중"
            action="인재풀 전체 진행 인원"
          />
          <KpiCard
            icon={CheckCircle2}
            label="매니저 확정"
            value={overview.confirmed}
            unit="명"
            description={`매니저가 직접 확정한 현재 인원 · 전체의 ${percentOf(overview.confirmed, overview.total)}`}
            href="/pipeline?status=확정인력"
            action="인재풀 전체 확정 인원"
          />
          <KpiCard
            icon={Users}
            label="기간 내 등록 지원자"
            value={overview.total}
            unit="명"
            description={`${dateRange} 등록 시각 기준 · 일괄 임포트 제외`}
            href="/pipeline"
            action="전체 인재풀 열기"
          />
        </div>
      </section>

      {overview.total === 0 ? (
        <section role="status" className="flex flex-col gap-4 rounded-3xl border border-border-strong bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-extrabold text-foreground">{dateRange} 등록된 지원자가 없습니다</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">데이터 조회는 완료됐으며, 일괄 임포트는 이 집계에서 제외됩니다. 지원자 유입 경로가 열려 있는지 공고에서 확인할 수 있습니다.</p>
          </div>
          <Button asChild variant="secondary">
            <Slottable>
              <Link href="/jobs">채용공고 확인</Link>
            </Slottable>
          </Button>
        </section>
      ) : null}

      <section aria-labelledby="report-cost-heading" className="grid grid-cols-1 gap-5 rounded-3xl border border-border-strong bg-card p-5 shadow-sm sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="flex items-start gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-warning-soft text-warning-strong">
            <Coins aria-hidden="true" size={21} />
          </div>
          <div>
            <p className="text-sm font-bold text-muted-foreground">최근 30일 누적 비용</p>
            <h2 id="report-cost-heading" className="mt-1 text-[28px] font-extrabold tracking-tight text-foreground">
              {Math.round(overview.costLast30Days).toLocaleString()}
              <span className="ml-1 text-sm font-semibold text-muted-foreground">원</span>
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">AI와 메시지 사용 비용의 합계입니다. 위의 지원자 접수 기간 선택에는 영향을 받지 않습니다.</p>
          </div>
        </div>
        <Button asChild variant="secondary">
          <Slottable>
            <Link href="/brain">AI 운영 현황 보기</Link>
          </Slottable>
        </Button>
      </section>

      <section aria-label="지원자 흐름 차트" className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
        <article className="rounded-3xl border border-border-strong bg-card p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-extrabold text-foreground">최근 6개월 지원자 등록 추이</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">선택 기간과 무관한 월별 등록 시각 기준입니다. 확정선은 각 월 등록자 중 현재 매니저 확정 상태인 인원이며, 일괄 임포트는 제외합니다.</p>
          <div className="mt-5 h-[300px]" role="img" aria-label="최근 6개월 지원자 등록 인원과 그중 현재 매니저 확정 상태인 인원의 추이">
            <ResponsiveContainer width="100%" height="100%" minHeight={180} minWidth={1}>
              <AreaChart data={trendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="reportsApplicants" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.28} />
                    <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="reportsConfirmed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-2)" stopOpacity={0.24} />
                    <stop offset="95%" stopColor="var(--chart-2)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-strong)" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} dy={10} />
                <YAxis axisLine={false} tickLine={false} allowDecimals={false} tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} />
                <RechartsTooltip
                  contentStyle={{ borderRadius: 12, border: "1px solid var(--border-strong)", background: "var(--surface-raised)", boxShadow: "var(--shadow-md)" }}
                  labelStyle={{ fontWeight: 700, color: "var(--foreground)", marginBottom: 4 }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 13, paddingTop: 20 }} />
                <Area type="monotone" dataKey="지원자" stroke="var(--chart-1)" strokeWidth={2} fill="url(#reportsApplicants)" />
                <Area type="monotone" dataKey="매니저 확정" stroke="var(--chart-2)" strokeWidth={2} fill="url(#reportsConfirmed)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <table className="sr-only">
            <caption>최근 6개월 지원자 등록 인원과 그중 현재 매니저 확정 상태인 인원</caption>
            <thead><tr><th>월</th><th>지원자</th><th>매니저 확정</th></tr></thead>
            <tbody>{overview.trend.map((month) => <tr key={month.month}><th>{month.month}</th><td>{month.applicants}</td><td>{month.confirmed}</td></tr>)}</tbody>
          </table>
        </article>

        <article className="rounded-3xl border border-border-strong bg-card p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-extrabold text-foreground">현재 단계 구성</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{dateRange} 등록 {overview.total.toLocaleString()}명의 현재 상태 스냅샷입니다. 전환율이나 과거 이동 이력이 아닙니다.</p>
          <div className="mt-5 h-[300px]" role="img" aria-label={`${dateRange} 등록 지원자의 현재 단계별 인원`}>
            <ResponsiveContainer width="100%" height="100%" minHeight={180} minWidth={1}>
              <BarChart data={stageData} layout="vertical" margin={{ top: 0, right: 22, left: 18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border-strong)" />
                <XAxis type="number" allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} />
                <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} width={102} tick={{ fontSize: 12, fill: "var(--foreground)", fontWeight: 600 }} />
                <RechartsTooltip
                  cursor={{ fill: "var(--muted)" }}
                  contentStyle={{ borderRadius: 12, border: "1px solid var(--border-strong)", background: "var(--surface-raised)", boxShadow: "var(--shadow-md)" }}
                />
                <Bar dataKey="인원" radius={[0, 6, 6, 0]} barSize={24}>
                  {stageData.map((stage, index) => (
                    <Cell
                      key={stage.key}
                      fill={stage.key === "other" ? "var(--muted-foreground)" : `var(--chart-step-${index + 1})`}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <table className="sr-only">
            <caption>{dateRange} 등록 지원자의 현재 단계별 인원</caption>
            <thead><tr><th>현재 단계</th><th>인원</th></tr></thead>
            <tbody>{overview.stages.map((stage) => <tr key={stage.key}><th>{STAGE_LABELS[stage.key]}</th><td>{stage.count}</td></tr>)}</tbody>
          </table>
        </article>
      </section>
    </>
  );
}
