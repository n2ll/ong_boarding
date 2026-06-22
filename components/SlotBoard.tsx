"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { LayoutGrid, Clock4, Users, AlertTriangle, Loader2, Filter } from "lucide-react";
import { toast } from "sonner";
import {
  SLOTS,
  type SlotKey,
  getSlotCapacity,
  matchesSlot,
  type Branch,
  type Applicant,
  type Client,
} from "@/lib/admin/types";

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

function sameBranch(a: string | null | undefined, name: string): boolean {
  return !!a && a.trim() === name.trim();
}

function confirmedSlots(a: Applicant): string[] {
  return (a.confirmed_slot ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function SlotBoard() {
  const [branches, setBranches] = useState<ApiBranch[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [loading, setLoading] = useState(true);
  const [clientFilter, setClientFilter] = useState<number | "">("");
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const [bRes, cRes, aRes] = await Promise.all([
        fetch("/api/admin/branches"),
        fetch("/api/admin/clients"),
        fetch("/api/admin/applicants"),
      ]);
      setBranches(((await bRes.json()).data ?? []) as ApiBranch[]);
      setClients(((await cRes.json()).data ?? []) as Client[]);
      setApplicants(((await aRes.json()).data ?? []) as Applicant[]);
    } catch {
      toast.error("슬롯 현황을 불러오지 못했어요");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const slotClientIds = useMemo(
    () => new Set(clients.filter((c) => c.uses_slots).map((c) => c.id)),
    [clients]
  );

  const visibleBranches = useMemo(() => {
    return branches
      .filter((b) => b.active)
      .filter((b) => (showAll ? true : b.client_id != null && slotClientIds.has(b.client_id)))
      .filter((b) => (clientFilter === "" ? true : b.client_id === clientFilter))
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [branches, slotClientIds, showAll, clientFilter]);

  const clientName = useCallback(
    (id: number | null) => clients.find((c) => c.id === id)?.name ?? "미지정",
    [clients]
  );

  // branch×slot 집계: 확정 인원(확정인력 + confirmed_slot 매칭), 대기/희망 인원(대기자 + work_hours 매칭)
  const cellFor = useCallback(
    (branchName: string, slot: SlotKey) => {
      let confirmed = 0;
      let waiting = 0;
      for (const a of applicants) {
        if (a.status === "확정인력") {
          if (
            confirmedSlots(a).includes(slot) &&
            (sameBranch(a.confirmed_branch, branchName) || sameBranch(a.branch, branchName))
          ) {
            confirmed++;
          }
        } else if (a.status === "대기자") {
          if (
            matchesSlot(a.work_hours, slot) &&
            (sameBranch(a.branch1, branchName) ||
              sameBranch(a.confirmed_branch, branchName) ||
              sameBranch(a.branch, branchName))
          ) {
            waiting++;
          }
        }
      }
      return { confirmed, waiting };
    },
    [applicants]
  );

  const totals = useMemo(() => {
    let cap = 0;
    let confirmed = 0;
    let waiting = 0;
    for (const b of visibleBranches) {
      const branch: Branch = { id: b.id, name: b.name, sort_order: 0, active: b.active, slot_capacity: b.slot_capacity ?? undefined };
      for (const s of SLOTS) {
        cap += getSlotCapacity(branch, s);
        const c = cellFor(b.name, s);
        confirmed += c.confirmed;
        waiting += c.waiting;
      }
    }
    return { cap, confirmed, waiting, fill: cap > 0 ? Math.round((confirmed / cap) * 100) : 0 };
  }, [visibleBranches, cellFor]);

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1 flex items-center gap-2">
            <LayoutGrid size={22} className="text-[#D69E2E]" /> 확정/희망 슬롯 보드
          </h1>
          <p className="text-[14px] text-[#718096]">지점 × 타임(평일/주말 · 오전/오후) 단위로 확정 인원과 정원, 대기(희망) 인원을 한눈에 봅니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-2 py-1">
            <Filter size={15} className="text-[#A0AEC0] ml-1" />
            <select
              value={clientFilter}
              onChange={(e) => setClientFilter(e.target.value === "" ? "" : Number(e.target.value))}
              className="bg-transparent text-sm font-semibold text-[#4A5568] py-1.5 pr-1 focus:outline-none cursor-pointer"
            >
              <option value="">전체 화주사</option>
              {clients.filter((c) => showAll || c.uses_slots).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => setShowAll((v) => !v)}
            className={`px-3.5 py-2 rounded-xl text-[13px] font-bold border transition-colors ${showAll ? "bg-[#1A202C] text-white border-[#1A202C]" : "bg-white text-[#4A5568] border-[#E2E8F0] hover:bg-[#F7FAFC]"}`}
            title="슬롯 미사용 화주사 지점까지 표시"
          >
            전체 지점 보기
          </button>
        </div>
      </div>

      {/* 요약 */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: "표시 지점", value: visibleBranches.length, unit: "곳", icon: LayoutGrid, color: "text-[#1A202C]" },
          { label: "확정 인원", value: totals.confirmed, unit: "명", icon: Users, color: "text-[#38A169]" },
          { label: "총 정원", value: totals.cap, unit: "명", icon: Clock4, color: "text-[#1A202C]" },
          { label: "대기(희망)", value: totals.waiting, unit: "명", icon: AlertTriangle, color: "text-[#D69E2E]" },
        ].map((s, i) => (
          <div key={i} className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm">
            <div className="flex items-center gap-1.5 text-[13px] font-bold text-[#718096] mb-2">
              <s.icon size={14} /> {s.label}
            </div>
            <div className="flex items-baseline gap-1">
              <span className={`text-[26px] font-extrabold tracking-tight leading-none ${s.color}`}>{s.value}</span>
              <span className="text-sm font-semibold text-[#A0AEC0]">{s.unit}</span>
            </div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-[#A0AEC0]"><Loader2 size={20} className="animate-spin mr-2" /> 불러오는 중…</div>
      ) : visibleBranches.length === 0 ? (
        <div className="bg-white border border-[#E2E8F0] rounded-2xl p-12 text-center text-[14px] text-[#718096]">
          표시할 지점이 없어요. 확정슬롯을 사용하는 화주사·지점을 등록하거나 <button onClick={() => setShowAll(true)} className="text-[#3182CE] font-bold hover:underline">전체 지점 보기</button>를 켜보세요.
        </div>
      ) : (
        <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-sm overflow-hidden">
          <div className="grid grid-cols-[1.4fr_repeat(4,1fr)] bg-[#F7FAFC] border-b border-[#E2E8F0] text-[13px] font-bold text-[#718096]">
            <div className="px-5 py-3.5">지점 / 화주사</div>
            {SLOTS.map((s) => (
              <div key={s} className="px-3 py-3.5 text-center border-l border-[#EDF2F7]">{SLOT_LABEL[s]}</div>
            ))}
          </div>
          {visibleBranches.map((b) => {
            const branch: Branch = { id: b.id, name: b.name, sort_order: 0, active: b.active, slot_capacity: b.slot_capacity ?? undefined };
            return (
              <div key={b.id} className="grid grid-cols-[1.4fr_repeat(4,1fr)] border-b border-[#F1F4F8] hover:bg-[#FCFDFE]">
                <div className="px-5 py-4 flex flex-col justify-center">
                  <div className="font-extrabold text-[#1A202C]">{b.name}</div>
                  <div className="text-[12px] text-[#A0AEC0] mt-0.5">{clientName(b.client_id)}</div>
                </div>
                {SLOTS.map((s) => {
                  const cap = getSlotCapacity(branch, s);
                  const { confirmed, waiting } = cellFor(b.name, s);
                  const ratio = cap > 0 ? Math.min(confirmed / cap, 1) : 0;
                  const full = confirmed >= cap && cap > 0;
                  const barColor = full ? "bg-[#38A169]" : confirmed > 0 ? "bg-[#D69E2E]" : "bg-[#E2E8F0]";
                  return (
                    <div key={s} className="px-3 py-4 border-l border-[#F1F4F8] flex flex-col items-center justify-center gap-1.5">
                      <div className="flex items-baseline gap-0.5">
                        <span className={`text-[17px] font-extrabold ${full ? "text-[#38A169]" : confirmed > 0 ? "text-[#1A202C]" : "text-[#CBD5E0]"}`}>{confirmed}</span>
                        <span className="text-[12px] font-bold text-[#A0AEC0]">/ {cap}</span>
                      </div>
                      <div className="w-full max-w-[88px] h-1.5 bg-[#EDF2F7] rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${ratio * 100}%` }} />
                      </div>
                      {waiting > 0 && (
                        <div className="text-[11px] font-bold text-[#D69E2E] flex items-center gap-0.5">
                          <Users size={10} /> 대기 {waiting}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-[12px] text-[#A0AEC0] leading-relaxed">
        · 확정 = 상태 ‘확정인력’ + 확정 슬롯(confirmed_slot) 매칭 인원 · 대기 = 상태 ‘대기자’ + 희망 시간대(work_hours) 매칭 인원.<br />
        · 정원은 지점 관리에서 슬롯별로 설정합니다. 슬롯을 쓰지 않는 화주사는 ‘전체 지점 보기’로만 표시됩니다.
      </p>
    </div>
  );
}
