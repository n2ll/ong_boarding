"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  RefreshCw,
  Search,
  Truck,
  Users,
} from "lucide-react";
import { jsonFetcher } from "@/lib/swr";
import { masterRegistryOverview } from "@/lib/admin/shipper-operations";
import { PageShell } from "./ui/page-shell";
import { Button } from "./ui/button";
import { controlBase } from "./ui/field";
import { Clients } from "./Clients";

interface Line {
  lineName: string;
  workDays: string | null;
  guaranteedDeliveries: number | null;
  startDate: string | null;
  endDate: string | null;
}

interface ClientMaster {
  id: string;
  name: string;
  lineCount: number;
  workerCount: number;
  lines: Line[];
}

interface MasterResponse {
  configured: boolean;
  clients: ClientMaster[];
}

export function Shippers() {
  const {
    data,
    error,
    isValidating,
    mutate,
  } = useSWR<MasterResponse>("/api/admin/ongmanaging/clients-master", jsonFetcher);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const masterClients = data?.clients;
  const master = masterRegistryOverview({
    clients: masterClients,
    configured: data?.configured,
    error,
  });
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  const filtered = useMemo(
    () => (masterClients ?? []).filter((client) => client.name.toLocaleLowerCase("ko-KR").includes(normalizedQuery)),
    [masterClients, normalizedQuery],
  );

  return (
    <PageShell className="mx-auto w-full max-w-6xl">
      <h1 className="sr-only">화주사</h1>

      <Clients />

      <section aria-labelledby="contract-master-heading" className="rounded-2xl border border-dashed border-border-strong bg-surface/60 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
              <ExternalLink aria-hidden="true" size={14} /> 외부 원본 · 읽기 전용
            </div>
            <h2 id="contract-master-heading" className="text-[16px] font-extrabold text-foreground">옹매니징 계약 원본</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              계약·배송라인 현황을 그대로 조회합니다. 운행 인원은 원본 시스템의 값이며, 이 콘솔의 인력 확정과는 다른 기준입니다.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void mutate()}
            isLoading={isValidating}
          >
            {!isValidating && <RefreshCw aria-hidden="true" />} {isValidating ? "새로고침 중" : "새로고침"}
          </Button>
        </div>

        {master.state === "loading" && (
          <div className="mt-5 grid gap-3 sm:grid-cols-3" aria-label="계약 원본 불러오는 중">
            {[0, 1, 2].map((item) => <div key={item} className="h-16 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />)}
          </div>
        )}

        {master.state === "error" && (
          <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-error/25 bg-error-soft px-4 py-3">
            <div className="flex min-w-0 items-start gap-2 text-[12px] font-bold text-error-strong">
              <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
              <span>계약 원본을 불러오지 못했습니다. 운영 화주사 목록에는 영향을 주지 않습니다.</span>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void mutate()}>다시 시도</Button>
          </div>
        )}

        {master.state === "unconfigured" && (
          <div className="mt-5 rounded-xl border border-border-strong bg-muted px-4 py-3 text-[12px] font-bold text-muted-foreground">
            옹매니징 연결이 설정되지 않아 계약 원본을 표시할 수 없습니다. 위 운영 목록은 정상적으로 사용할 수 있습니다.
          </div>
        )}

        {master.state === "empty" && (
          <div className="mt-5 rounded-xl border border-dashed border-border-strong bg-card px-4 py-8 text-center">
            <div className="text-[13px] font-extrabold text-foreground">원본에 등록된 화주사가 없습니다</div>
            <p className="mt-1 text-[12px] text-muted-foreground">옹매니징에서 계약 화주사를 등록한 뒤 새로고침해주세요.</p>
          </div>
        )}

        {master.state === "ready" && (
          <div className="mt-5 space-y-4">
            <div className="grid grid-cols-3 divide-x divide-border-strong rounded-xl border border-border-strong bg-card py-3 shadow-xs">
              <div className="px-3 text-center"><div className="tabular-nums text-[18px] font-extrabold text-foreground">{master.clients}</div><div className="text-xs font-bold text-muted-foreground">화주사</div></div>
              <div className="px-3 text-center"><div className="tabular-nums text-[18px] font-extrabold text-foreground">{master.lines}</div><div className="text-xs font-bold text-muted-foreground">배송라인</div></div>
              <div className="px-3 text-center"><div className="tabular-nums text-[18px] font-extrabold text-foreground">{master.workers}</div><div className="text-xs font-bold text-muted-foreground">운행 인원</div></div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="relative block w-full sm:w-[280px]">
                <span className="sr-only">원본 화주사 검색</span>
                <Search aria-hidden="true" size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="원본 화주사 검색"
                  className={`${controlBase} min-h-11 py-2.5 pl-10`}
                />
              </label>
              <span className="text-xs font-bold text-muted-foreground">{filtered.length}곳 표시</span>
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border-strong bg-card px-4 py-8 text-center text-[12px] text-muted-foreground">
                ‘{query.trim()}’에 맞는 원본 화주사가 없습니다.
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border-strong bg-card">
                {filtered.map((client) => {
                  const open = openId === client.id;
                  const detailsId = `master-client-${client.id}-lines`;
                  return (
                    <article key={client.id} className="border-b border-border last:border-b-0">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={detailsId}
                        onClick={() => setOpenId(open ? null : client.id)}
                        className="grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="flex min-w-0 items-center gap-2 font-extrabold text-foreground">
                          <ChevronDown aria-hidden="true" size={15} className={`shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`} />
                          <span className="truncate">{client.name}</span>
                        </span>
                        <span className="flex items-center gap-1 text-xs font-bold text-foreground"><Truck aria-hidden="true" size={13} className="text-muted-foreground" /> {client.lineCount}</span>
                        <span className="flex items-center gap-1 text-xs font-bold text-foreground"><Users aria-hidden="true" size={13} className="text-muted-foreground" /> {client.workerCount}</span>
                      </button>

                      {open && (
                        <div id={detailsId} className="border-t border-border bg-background/55 px-4 py-4 sm:pl-10">
                          {client.lines.length === 0 ? (
                            <p className="text-[12px] text-muted-foreground">등록된 배송라인이 없습니다.</p>
                          ) : (
                            <ul className="grid gap-2 lg:grid-cols-2">
                              {client.lines.map((line, index) => (
                                <li key={`${line.lineName}-${index}`} className="rounded-xl border border-border-strong bg-card px-3 py-2.5">
                                  <div className="text-[12px] font-extrabold text-foreground">{line.lineName}</div>
                                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium text-muted-foreground">
                                    {line.workDays && <span>근무 {line.workDays}</span>}
                                    {line.guaranteedDeliveries != null && <span>보장 {line.guaranteedDeliveries}건</span>}
                                    {line.startDate && <span>{line.startDate}{line.endDate ? ` ~ ${line.endDate}` : " ~"}</span>}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>
    </PageShell>
  );
}
