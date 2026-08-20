"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  CheckCircle2,
  Clock4,
  Filter,
  LayoutGrid,
  RefreshCw,
  Settings2,
  Users,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { PageShell } from "@/components/ui/page-shell";
import {
  buildSlotBoardOverview,
  type SlotBoardApplicant,
  type SlotBoardClient,
} from "@/lib/admin/slot-board-overview";
import { DEFAULT_SLOT_CAPACITY, SLOTS, type SlotKey } from "@/lib/admin/types";

interface ApiBranch {
  id: number;
  name: string;
  active: boolean;
  client_id: number | null;
  slot_capacity: Record<string, number> | null;
}

const SLOT_LABEL: Record<SlotKey, string> = {
  평일오전: "평일 · 오전",
  평일오후: "평일 · 오후",
  주말오전: "주말 · 오전",
  주말오후: "주말 · 오후",
};

const SOURCE_LABEL = {
  branches: "지점",
  clients: "화주사",
  applicants: "지원자 집계",
} as const;

export function SlotBoard() {
  const [clientFilter, setClientFilter] = useState<number | "all">("all");
  const [sortMode, setSortMode] = useState<"shortage" | "name">("shortage");

  // 세 화면과 같은 SWR 키를 유지해 캐시를 공유하고, 숫자 집계용 응답만 받는다.
  const {
    data: branchesApi,
    error: branchesError,
    isValidating: branchesValidating,
    mutate: mutateBranches,
  } = useSWR<{ data?: ApiBranch[] }>("/api/admin/branches");
  const {
    data: clientsApi,
    error: clientsError,
    isValidating: clientsValidating,
    mutate: mutateClients,
  } = useSWR<{ data?: SlotBoardClient[] }>("/api/admin/clients");
  const {
    data: applicantsApi,
    error: applicantsError,
    isValidating: applicantsValidating,
    mutate: mutateApplicants,
  } = useSWR<{ data?: SlotBoardApplicant[] }>("/api/admin/applicants?scope=rollup");

  const overview = useMemo(() => buildSlotBoardOverview({
    branches: branchesApi ? branchesApi.data ?? [] : undefined,
    clients: clientsApi ? clientsApi.data ?? [] : undefined,
    applicants: applicantsApi ? applicantsApi.data ?? [] : undefined,
    slots: SLOTS,
    defaultCapacity: DEFAULT_SLOT_CAPACITY,
    clientId: clientFilter === "all" ? null : clientFilter,
    errors: {
      branches: branchesError,
      clients: clientsError,
      applicants: applicantsError,
    },
  }), [
    applicantsApi,
    applicantsError,
    branchesApi,
    branchesError,
    clientFilter,
    clientsApi,
    clientsError,
  ]);

  const slotClients = useMemo(
    () => (clientsApi?.data ?? [])
      .filter((client) => client.uses_slots && client.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [clientsApi],
  );
  const rows = useMemo(() => {
    if (overview.state !== "ready" || sortMode === "shortage") return overview.state === "ready" ? overview.rows : [];
    return [...overview.rows].sort((a, b) => a.branch.name.localeCompare(b.branch.name, "ko"));
  }, [overview, sortMode]);
  const refreshing = branchesValidating || clientsValidating || applicantsValidating;
  const retryAll = useCallback(() => {
    void Promise.all([mutateBranches(), mutateClients(), mutateApplicants()]);
  }, [mutateApplicants, mutateBranches, mutateClients]);

  return (
    <PageShell>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <div className="mb-2 flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.12em] text-warning-strong">
            <LayoutGrid aria-hidden="true" size={16} /> Staffing control
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground">슬롯 충원 보드</h1>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            매니저가 기록한 확정 상태와 희망 정보를 기준으로, 부족한 지점과 시간대를 먼저 확인합니다.
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={retryAll} isLoading={refreshing}>
          <RefreshCw aria-hidden="true" /> 새로고침
        </Button>
      </header>

      <section aria-label="슬롯 보드 필터" className="flex flex-wrap items-end gap-3 rounded-2xl border border-border-strong bg-card p-3 shadow-xs">
        <div className="min-w-[210px] flex-1 sm:flex-none">
          <label htmlFor="slot-client-filter" className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-muted-foreground">
            <Filter aria-hidden="true" size={14} /> 화주사 범위
          </label>
          <select
            id="slot-client-filter"
            value={clientFilter}
            onChange={(event) => setClientFilter(event.target.value === "all" ? "all" : Number(event.target.value))}
            disabled={overview.state !== "ready"}
            className="min-h-11 w-full cursor-pointer rounded-xl border border-border-strong bg-input-background px-3 text-sm font-bold text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="all">전체 슬롯 화주사</option>
            {slotClients.map((client) => (
              <option key={client.id} value={client.id}>{client.name}</option>
            ))}
          </select>
        </div>
        <div className="min-w-[180px] flex-1 sm:flex-none">
          <label htmlFor="slot-sort" className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-muted-foreground">
            <ArrowDownWideNarrow aria-hidden="true" size={14} /> 지점 정렬
          </label>
          <select
            id="slot-sort"
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as "shortage" | "name")}
            disabled={overview.state !== "ready"}
            className="min-h-11 w-full cursor-pointer rounded-xl border border-border-strong bg-input-background px-3 text-sm font-bold text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="shortage">부족 규모가 큰 순</option>
            <option value="name">지점 이름순</option>
          </select>
        </div>
        <p className="ml-auto max-w-xl text-xs leading-relaxed text-muted-foreground">
          이 화면은 조회 전용입니다. 여기 표시되는 대기 인원은 희망 조건이 일치하는 사람이며, 근무 확정이나 배정을 뜻하지 않습니다.
        </p>
      </section>

      {overview.state === "loading" ? (
        <section aria-live="polite" aria-busy="true">
          <p className="mb-3 text-sm font-bold text-muted-foreground">슬롯 현황을 불러오는 중입니다.</p>
          <div aria-hidden="true" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((item) => (
              <div key={item} className="h-28 animate-pulse rounded-2xl border border-border bg-card motion-reduce:animate-none" />
            ))}
          </div>
          <div aria-hidden="true" className="mt-6 h-80 animate-pulse rounded-2xl border border-border bg-card motion-reduce:animate-none" />
        </section>
      ) : overview.state === "error" ? (
        <section role="alert" className="rounded-2xl border border-error/30 bg-error-soft p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="flex items-center gap-2 text-base font-extrabold text-error-strong">
                <AlertTriangle aria-hidden="true" size={18} /> 슬롯 현황을 계산할 수 없습니다
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-error-strong">
                {overview.sources.map((source) => SOURCE_LABEL[source]).join(", ")} 데이터를 불러오지 못했습니다. 실패한 값을 0으로 표시하지 않았습니다.
              </p>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={retryAll} isLoading={refreshing}>
              다시 불러오기
            </Button>
          </div>
        </section>
      ) : (
        <>
          <section aria-labelledby="slot-summary-title">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 id="slot-summary-title" className="text-lg font-extrabold text-foreground">현재 충원 판단</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">활성 슬롯 지점 {overview.totals.branchCount.toLocaleString("ko-KR")}곳 기준</p>
              </div>
              {overview.totals.defaultCapacityCells > 0 && (
                <div className="flex items-center gap-2 rounded-xl bg-warning-soft px-3 py-2 text-xs font-bold text-warning-strong">
                  <Settings2 aria-hidden="true" size={15} />
                  기본 정원 적용 {overview.totals.defaultCapacityCells.toLocaleString("ko-KR")}칸
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricCard
                label="부족 슬롯"
                value={overview.totals.shortageSlots}
                unit="칸"
                hint="정원보다 확정 커버가 적은 시간대"
                icon={AlertTriangle}
                tone={overview.totals.shortageSlots > 0 ? "warning" : "success"}
              />
              <MetricCard
                label="추가 필요"
                value={overview.totals.totalGap}
                unit="명·슬롯"
                hint="각 슬롯 부족분을 합한 운영 단위"
                icon={Users}
                tone={overview.totals.totalGap > 0 ? "warning" : "success"}
              />
              <MetricCard
                label="확정 커버"
                value={overview.totals.confirmedCoverage}
                unit={`/ ${overview.totals.capacity.toLocaleString("ko-KR")} 명·슬롯`}
                hint={`실제 확정 인원 ${overview.totals.confirmedHeadcount.toLocaleString("ko-KR")}명`}
                icon={CheckCircle2}
                tone="neutral"
              />
              <MetricCard
                label="희망 일치 대기"
                value={overview.totals.waitingHeadcount}
                unit="명"
                hint="검토 후보이며 확정 인원이 아님"
                icon={Clock4}
                tone="neutral"
              />
            </div>
          </section>

          {overview.rows.length === 0 ? (
            <section className="rounded-2xl border border-border-strong bg-card px-6 py-12 text-center shadow-xs">
              <LayoutGrid aria-hidden="true" className="mx-auto text-muted-foreground" size={28} />
              <h2 className="mt-3 text-lg font-extrabold text-foreground">
                {clientFilter === "all" ? "표시할 활성 슬롯 지점이 없습니다" : "선택한 화주사에 활성 슬롯 지점이 없습니다"}
              </h2>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                슬롯 보드는 ‘확정슬롯 사용’이 켜진 활성 화주사와 활성 지점만 표시합니다. 화주사·지점 설정을 확인해 주세요.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {clientFilter !== "all" && (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setClientFilter("all")}>전체 화주사 보기</Button>
                )}
                <Link
                  href="/settings?section=branches"
                  className={buttonVariants({ variant: "primary", size: "sm" })}
                >
                  지점 설정 열기
                </Link>
              </div>
            </section>
          ) : (
            <>
              <section aria-labelledby="slot-priority-title" className="rounded-2xl border border-border-strong bg-foreground p-5 text-primary-foreground shadow-md sm:p-6">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <div className="mb-1 flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.12em] text-warning-on-dark">
                      <AlertTriangle aria-hidden="true" size={15} /> Priority queue
                    </div>
                    <h2 id="slot-priority-title" className="text-lg font-extrabold">먼저 볼 부족 슬롯</h2>
                    <p className="mt-1 text-xs leading-relaxed text-primary-foreground/70">부족 인원이 큰 순서입니다. 대기 표시는 희망 조건 일치만 뜻합니다.</p>
                  </div>
                  <span className="rounded-full border border-primary-foreground/15 px-3 py-1.5 text-xs font-bold text-primary-foreground/80">
                    부족 {overview.totals.shortageSlots.toLocaleString("ko-KR")}칸
                  </span>
                </div>
                {overview.priorities.length === 0 ? (
                  <div className="mt-5 flex items-center gap-3 rounded-xl border border-primary-foreground/15 bg-primary-foreground/10 p-4">
                    <CheckCircle2 aria-hidden="true" className="text-success-on-dark" size={20} />
                    <p className="text-sm font-bold">현재 입력된 확정 커버가 모든 운영 정원을 충족합니다.</p>
                  </div>
                ) : (
                  <ol className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {overview.priorities.slice(0, 6).map((item, index) => (
                      <li key={`${item.branchId}-${item.slot}`} className="rounded-xl border border-primary-foreground/15 bg-primary-foreground/10 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-xs font-bold text-primary-foreground/70">
                              <span className="flex size-6 items-center justify-center rounded-full bg-brand-yellow font-extrabold text-foreground">{index + 1}</span>
                              {SLOT_LABEL[item.slot]}
                            </div>
                            <p className="mt-2 truncate text-base font-extrabold">{item.branchName}</p>
                            <p className="mt-1 text-xs font-bold text-warning-on-dark">{item.gap.toLocaleString("ko-KR")}명 부족</p>
                          </div>
                          <span className="rounded-lg bg-primary-foreground/10 px-2 py-1 text-right text-xs font-bold text-primary-foreground/80">
                            {item.waiting > 0 ? `희망 일치 대기 ${item.waiting}명` : "희망 일치 대기 없음"}
                          </span>
                        </div>
                        <a
                          href={`#slot-branch-${item.branchId}`}
                          className={buttonVariants({
                            variant: "glass",
                            size: "toolbar",
                            className: "mt-3 w-full border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/20",
                          })}
                        >
                          표에서 확인
                        </a>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section aria-labelledby="slot-table-title">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <h2 id="slot-table-title" className="text-lg font-extrabold text-foreground">지점 × 시간대 상세</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">각 칸은 확정 커버 / 운영 정원이며, 대기는 별도 희망 인원입니다.</p>
                  </div>
                  <span className="text-xs font-bold text-muted-foreground">{sortMode === "shortage" ? "부족 규모순" : "지점 이름순"}</span>
                </div>
                <div className="overflow-x-auto rounded-2xl border border-border-strong bg-card shadow-sm">
                  <table className="w-full min-w-[780px] border-collapse text-sm">
                    <caption className="sr-only">활성 슬롯 지점별 운영 정원, 확정 커버, 부족 인원, 희망 일치 대기 인원</caption>
                    <thead className="bg-background text-xs text-muted-foreground">
                      <tr>
                        <th scope="col" className="sticky left-0 z-10 w-[220px] border-b border-border-strong bg-background px-5 py-3.5 text-left font-extrabold">지점 / 화주사</th>
                        {SLOTS.map((slot) => (
                          <th key={slot} scope="col" className="min-w-[140px] border-b border-l border-border-strong px-3 py-3.5 text-center font-extrabold">
                            {SLOT_LABEL[slot]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr
                          id={`slot-branch-${row.branch.id}`}
                          key={row.branch.id}
                          tabIndex={-1}
                          className="scroll-mt-24 border-b border-border last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          <th scope="row" className="sticky left-0 z-10 bg-card px-5 py-4 text-left align-middle">
                            <div className="font-extrabold text-foreground">{row.branch.name}</div>
                            <div className="mt-1 text-xs font-medium text-muted-foreground">{row.client.name}</div>
                            {row.totalGap > 0 ? (
                              <div className="mt-2 inline-flex items-center gap-1 rounded-lg bg-warning-soft px-2 py-1 text-xs font-extrabold text-warning-strong">
                                <AlertTriangle aria-hidden="true" size={13} /> 합계 {row.totalGap.toLocaleString("ko-KR")}명 부족
                              </div>
                            ) : (
                              <div className="mt-2 inline-flex items-center gap-1 rounded-lg bg-success-soft px-2 py-1 text-xs font-extrabold text-success-strong">
                                <CheckCircle2 aria-hidden="true" size={13} /> 정원 충족
                              </div>
                            )}
                          </th>
                          {row.cells.map((cell) => {
                            const progress = cell.capacity > 0 ? Math.min(100, Math.round((cell.confirmed / cell.capacity) * 100)) : 0;
                            const over = Math.max(0, cell.confirmed - cell.capacity);
                            const isShort = cell.gap > 0;
                            return (
                              <td
                                key={cell.slot}
                                className={`border-l border-border-strong px-3 py-4 text-center align-middle ${isShort ? "bg-warning-soft/45" : "bg-card"}`}
                              >
                                <div className="flex items-baseline justify-center gap-1 tabular-nums">
                                  <span className={`text-lg font-extrabold ${isShort ? "text-warning-strong" : "text-foreground"}`}>{cell.confirmed.toLocaleString("ko-KR")}</span>
                                  <span className="text-xs font-bold text-muted-foreground">/ {cell.capacity.toLocaleString("ko-KR")}</span>
                                </div>
                                {cell.capacity > 0 ? (
                                  <div
                                    role="progressbar"
                                    aria-label={`${row.branch.name} ${SLOT_LABEL[cell.slot]} 확정 커버`}
                                    aria-valuemin={0}
                                    aria-valuemax={cell.capacity}
                                    aria-valuenow={Math.min(cell.confirmed, cell.capacity)}
                                    aria-valuetext={`확정 커버 ${cell.confirmed}명, 운영 정원 ${cell.capacity}명`}
                                    className="mx-auto mt-2 h-2 w-full max-w-24 overflow-hidden rounded-full bg-muted"
                                  >
                                    <div className={`h-full rounded-full ${isShort ? "bg-warning" : "bg-success"}`} style={{ width: `${progress}%` }} />
                                  </div>
                                ) : (
                                  <div className="mx-auto mt-2 h-2 w-full max-w-24 rounded-full bg-muted" aria-hidden="true" />
                                )}
                                <div className="mt-2 min-h-9 text-xs font-bold leading-relaxed">
                                  {cell.capacity === 0 ? (
                                    <span className="text-muted-foreground">운영 정원 0</span>
                                  ) : isShort ? (
                                    <span className="text-warning-strong">{cell.gap.toLocaleString("ko-KR")}명 부족</span>
                                  ) : over > 0 ? (
                                    <span className="text-info-strong">정원 초과 +{over.toLocaleString("ko-KR")}</span>
                                  ) : (
                                    <span className="text-success-strong">정원 충족</span>
                                  )}
                                  <br />
                                  <span className={cell.waiting > 0 ? "text-foreground" : "text-muted-foreground"}>희망 일치 대기 {cell.waiting.toLocaleString("ko-KR")}명</span>
                                </div>
                                {cell.capacitySource === "default" && (
                                  <span className="mt-2 inline-block rounded-md border border-border-strong px-1.5 py-0.5 text-xs font-bold text-muted-foreground">기본 정원</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section aria-labelledby="slot-definition-title" className="rounded-2xl border border-border-strong bg-card p-5 shadow-xs">
                <h2 id="slot-definition-title" className="text-sm font-extrabold text-foreground">숫자 기준</h2>
                <dl className="mt-3 grid gap-3 text-xs leading-relaxed md:grid-cols-3">
                  <div className="rounded-xl bg-background p-3">
                    <dt className="font-extrabold text-foreground">운영 정원</dt>
                    <dd className="mt-1 text-muted-foreground">지점 관리에서 입력한 슬롯별 인원입니다. 값이 없으면 오전 3명·오후 4명의 기본값을 씁니다.</dd>
                  </div>
                  <div className="rounded-xl bg-background p-3">
                    <dt className="font-extrabold text-foreground">확정 커버</dt>
                    <dd className="mt-1 text-muted-foreground">매니저가 ‘확정인력’으로 변경한 사람만 셉니다. 확정 지점·슬롯이 비어 있으면 기존 희망 정보로 보완합니다.</dd>
                  </div>
                  <div className="rounded-xl bg-background p-3">
                    <dt className="font-extrabold text-foreground">희망 일치 대기</dt>
                    <dd className="mt-1 text-muted-foreground">‘대기자’ 상태에서 지점과 희망 시간이 일치한 인원입니다. 검토 대상일 뿐 근무 확정이나 배정이 아닙니다.</dd>
                  </div>
                </dl>
              </section>
            </>
          )}
        </>
      )}
    </PageShell>
  );
}

function MetricCard({
  label,
  value,
  unit,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  unit: string;
  hint: string;
  icon: typeof LayoutGrid;
  tone: "warning" | "success" | "neutral";
}) {
  const toneClass = tone === "warning"
    ? "bg-warning-soft text-warning-strong"
    : tone === "success"
      ? "bg-success-soft text-success-strong"
      : "bg-muted text-foreground";
  return (
    <div className="rounded-2xl border border-border-strong bg-card p-4 shadow-xs sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-extrabold text-muted-foreground">{label}</span>
        <span className={`flex size-8 items-center justify-center rounded-xl ${toneClass}`}>
          <Icon aria-hidden="true" size={16} />
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-1 tabular-nums">
        <span className="text-2xl font-extrabold tracking-tight text-foreground">{value.toLocaleString("ko-KR")}</span>
        <span className="text-xs font-bold text-muted-foreground">{unit}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}
