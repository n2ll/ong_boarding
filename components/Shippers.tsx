"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { Building2, Search, ChevronRight, ChevronDown, Loader2, Truck, Users } from "lucide-react";
import { jsonFetcher } from "@/lib/swr";

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
interface Resp {
  configured: boolean;
  clients: ClientMaster[];
}

export function Shippers() {
  const { data, error, isLoading } = useSWR<Resp>(
    "/api/admin/ongmanaging/clients-master",
    jsonFetcher
  );
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const clients = data?.clients ?? [];
  const filtered = useMemo(
    () => clients.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase())),
    [clients, q]
  );
  const totalLines = clients.reduce((s, c) => s + c.lineCount, 0);
  const totalWorkers = clients.reduce((s, c) => s + c.workerCount, 0);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div>
        <h1 className="text-[20px] font-extrabold text-[#1A202C] flex items-center gap-2">
          <Building2 size={20} /> 화주사 · 라인 현황
        </h1>
        <p className="text-[13px] text-[#718096] mt-1">
          옹매니징 계약 화주사와 배송라인 (읽기 전용 미러)
        </p>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-xl bg-[#FFF5F5] border border-[#FEB2B2] text-[13px] font-semibold text-[#C53030]">
          화주사 정보를 불러오지 못했어요.
        </div>
      )}

      {!error && data && !data.configured && (
        <div className="px-4 py-3 rounded-xl bg-[#EDF2F7] border border-[#E2E8F0] text-[13px] font-semibold text-[#718096]">
          옹매니징 미연동 — 화주사 정보를 표시할 수 없어요.
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-[13px] font-bold text-[#718096]">
          <Loader2 size={16} className="animate-spin" /> 불러오는 중…
        </div>
      )}

      {data?.configured && (
        <>
          <div className="flex flex-wrap gap-2 text-[12.5px] font-bold text-[#4A5568]">
            <span className="px-3 py-1.5 rounded-lg bg-[#EBF8FF] text-[#3182CE]">화주사 {clients.length}</span>
            <span className="px-3 py-1.5 rounded-lg bg-[#F0FFF4] text-[#2F855A]">배송라인 {totalLines}</span>
            <span className="px-3 py-1.5 rounded-lg bg-[#FFFBEB] text-[#B7791F]">배정 인원 {totalWorkers}</span>
          </div>

          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="화주사 검색"
              className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-[#E2E8F0] text-[14px] outline-none focus:border-[#FFCB3C] bg-white"
            />
          </div>

          <div className="space-y-2">
            {filtered.length === 0 && (
              <div className="text-[13px] text-[#A0AEC0] py-6 text-center">화주사가 없어요.</div>
            )}
            {filtered.map((c) => {
              const open = openId === c.id;
              return (
                <div key={c.id} className="rounded-xl border border-[#E2E8F0] bg-white overflow-hidden">
                  <button
                    onClick={() => setOpenId(open ? null : c.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#F7FAFC] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                  >
                    {open ? (
                      <ChevronDown size={16} className="text-[#A0AEC0] shrink-0" />
                    ) : (
                      <ChevronRight size={16} className="text-[#A0AEC0] shrink-0" />
                    )}
                    <span className="flex-1 font-bold text-[14px] text-[#1A202C]">{c.name}</span>
                    <span className="flex items-center gap-1 text-[12px] font-bold text-[#2F855A]">
                      <Truck size={13} /> {c.lineCount}
                    </span>
                    <span className="flex items-center gap-1 text-[12px] font-bold text-[#B7791F]">
                      <Users size={13} /> {c.workerCount}
                    </span>
                  </button>

                  {open && (
                    <div className="border-t border-[#EDF2F7] px-4 py-3 bg-[#FAFCFF]">
                      {c.lines.length === 0 ? (
                        <div className="text-[12.5px] text-[#A0AEC0]">등록된 배송라인이 없어요.</div>
                      ) : (
                        <div className="space-y-1.5">
                          {c.lines.map((l, i) => (
                            <div
                              key={i}
                              className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-[#4A5568]"
                            >
                              <span className="font-bold text-[#276749]">{l.lineName}</span>
                              {l.workDays && <span className="text-[#718096]">근무 {l.workDays}</span>}
                              {l.guaranteedDeliveries != null && (
                                <span className="text-[#718096]">보장 {l.guaranteedDeliveries}건</span>
                              )}
                              {l.startDate && (
                                <span className="text-[#A0AEC0]">
                                  {l.startDate}
                                  {l.endDate ? ` ~ ${l.endDate}` : " ~"}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
