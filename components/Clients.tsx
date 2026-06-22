import { useState } from "react";
import { Building2, Handshake, MoreHorizontal, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { DemoBanner } from "./DemoBanner";

const MOCK_CLIENTS = [
  { id: "C-01", name: "우아한형제들 (비마트)", manager: "김배달 팀장", branches: 15, activeJobs: 24, status: "계약 중", end: "2027.12.31" },
  { id: "C-02", name: "스타벅스코리아", manager: "이별다방 파트장", branches: 8, activeJobs: 5, status: "계약 중", end: "2026.10.15" },
  { id: "C-03", name: "올리브영", manager: "박올리브 매니저", branches: 12, activeJobs: 0, status: "계약 만료", end: "2026.01.30" },
];

export function Clients() {
  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      <DemoBanner variant="soon" note="화주사 → 지점 → 공고 계층은 설계 단계입니다. 아래 목록은 예시이며, clients 테이블 신설 후 실제 등록·연동이 제공됩니다." />
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1 flex items-center gap-2">화주사 관리 <span className="text-[11px] font-bold text-[#718096] bg-[#EDF2F7] px-2 py-0.5 rounded align-middle">준비중</span></h1>
          <p className="text-[14px] text-[#718096]">플랫폼과 계약된 기업(B2B) 고객사를 관리합니다.</p>
        </div>
        <button 
          onClick={() => toast.success("신규 화주사 등록 모달이 열립니다.")}
          className="flex items-center gap-2 bg-[#1A202C] hover:bg-[#2D3748] text-white px-5 py-2.5 rounded-xl font-bold transition-colors"
        >
          <Plus size={18} /> 신규 화주사 등록
        </button>
      </div>

      <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-sm overflow-hidden flex flex-col">
        <div className="p-5 border-b border-[#E2E8F0] flex items-center justify-between">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
            <input 
              type="text" 
              placeholder="기업명 검색" 
              className="pl-9 pr-4 py-2 border border-[#E2E8F0] rounded-xl text-sm w-[260px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
            />
          </div>
        </div>

        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_0.5fr] items-center px-6 py-3.5 border-b border-[#E2E8F0] bg-[#F7FAFC] text-[13px] font-bold text-[#718096]">
          <div>화주사 명</div>
          <div>담당자</div>
          <div>등록 지점 수</div>
          <div>진행 공고 수</div>
          <div>계약 상태</div>
          <div className="text-right">관리</div>
        </div>

        <div className="flex flex-col">
          {MOCK_CLIENTS.map(client => (
            <div key={client.id} className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_0.5fr] items-center px-6 py-5 border-b border-[#F1F4F8] hover:bg-[#F7FAFC] transition-colors">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-[#EDF2F7] rounded-lg flex items-center justify-center">
                  <Building2 size={18} className="text-[#A0AEC0]" />
                </div>
                <div className="font-extrabold text-[#1A202C]">{client.name}</div>
              </div>
              <div className="text-[14px] text-[#4A5568]">{client.manager}</div>
              <div className="text-[14px] font-bold text-[#1A202C]">{client.branches}개</div>
              <div className="text-[14px] font-bold text-[#3182CE]">{client.activeJobs}건</div>
              <div>
                <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold ${client.status === '계약 중' ? 'bg-[#F0FFF4] text-[#38A169] border border-[#C6F6D5]' : 'bg-[#F1F4F8] text-[#718096] border border-[#E2E8F0]'}`}>
                  <Handshake size={12} /> {client.status}
                </span>
                <div className="text-[11px] text-[#A0AEC0] mt-1 ml-1">~{client.end}</div>
              </div>
              <div className="flex justify-end">
                <button className="p-2 text-[#718096] hover:bg-[#E2E8F0] rounded-lg transition-colors">
                  <MoreHorizontal size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}