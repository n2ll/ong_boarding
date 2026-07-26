"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { Building2, Search, ChevronRight, ChevronDown, Loader2, Truck, Users } from "lucide-react";
import { jsonFetcher } from "@/lib/swr";
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
          <Building2 size={20} /> 화주사
        </h1>
        <p className="text-[13px] text-[#718096] mt-1">
          공고에 쓰는 화주사를 관리하고, 계약 원본(옹매니징)의 배송라인·운행 인원을 함께 확인합니다.
        </p>
      </div>

      {/* 화주사 화면이 둘(여기 = 계약 원본 현황 / 설정 › 화주사 관리 = 공고용 목록)이라 어디가 원본인지
          헷갈렸다 → 한 화면으로 합친다. 위=공고에 쓰는 목록(편집·동기화), 아래=계약 원본(읽기 전용). */}
      <section className="space-y-2">
        <div>
          <h2 className="text-[15px] font-extrabold text-[#1A202C]">공고에 쓰는 화주사</h2>
          <p className="text-[12.5px] text-[#718096] mt-0.5">
            공고를 등록할 때 고르는 목록이에요. 계약 원본에 있는 화주사를 여기로 가져오려면 <b>‘옹매니징 동기화’</b>를 누르세요.
          </p>
        </div>
        <div className="rounded-2xl border border-[#E2E8F0] bg-white p-4">
          <Clients embedded />
        </div>
      </section>

      <section className="space-y-2">
        <div>
          <h2 className="text-[15px] font-extrabold text-[#1A202C]">계약 원본 (옹매니징)</h2>
          <p className="text-[12.5px] text-[#718096] mt-0.5">
            계약·배송라인의 원본 시스템에서 그대로 읽어옵니다(여기서는 수정할 수 없어요).
            ‘운행 인원’은 그 라인에서 실제 운행 중인 인원으로, 이 콘솔의 <b>확정</b>과는 다른 값이에요.
          </p>
        </div>

      {error && (
        <div className="px-4 py-3 rounded-xl bg-[#FFF5F5] border border-[#FEB2B2] text-[13px] font-semibold text-[#C53030]">
          화주사 정보를 불러오지 못했어요.
        </div>
      )}

      {!error && data && !data.configured && (
        <div className="px-4 py-3 rounded-xl bg-[#EDF2F7] border border-[#E2E8F0] text-[13px] font-semibold text-[#718096]">
          계약 원본(옹매니징)에 연결되지 않아 배송라인·운행 인원을 표시할 수 없어요. 위 목록은 정상 사용할 수 있어요.
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
            <span className="px-3 py-1.5 rounded-lg bg-[#FFFBEB] text-[#B7791F]">운행 인원 {totalWorkers}</span>
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
      </section>
    </div>
  );
}
