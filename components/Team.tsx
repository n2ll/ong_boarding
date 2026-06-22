import { useState, useEffect } from "react";
import { Shield, UserPlus, Phone, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

interface SiteManager {
  id: number;
  name: string;
  phone: string | null;
  branch: string | null;
  role: string | null;
  note: string | null;
  active: boolean;
}

export function Team() {
  const [members, setMembers] = useState<SiteManager[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/site-managers");
        const json = await res.json();
        setMembers((json.data ?? []) as SiteManager[]);
      } catch {
        toast.error("담당자 목록을 불러오지 못했어요");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleInvite = () => {
    toast.info("담당자 등록은 준비 중이에요");
  };

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">팀 · 권한</h1>
          <p className="text-[14px] text-[#718096]">현장 담당자와 지점 관리자 연락처·권한을 관리합니다.</p>
        </div>
        <button
          onClick={handleInvite}
          className="flex items-center gap-2 bg-[#FFCB3C] hover:bg-[#E0B500] text-[#1A202C] px-5 py-2.5 rounded-xl font-bold transition-colors"
        >
          <UserPlus size={18} /> 담당자 추가
        </button>
      </div>

      <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-sm overflow-hidden flex flex-col">
        <div className="grid grid-cols-[2fr_1.5fr_1.5fr_1fr_0.5fr] items-center px-6 py-3.5 border-b border-[#E2E8F0] bg-[#F7FAFC] text-[13px] font-bold text-[#718096]">
          <div>이름 / 연락처</div>
          <div>권한 (Role)</div>
          <div>담당 지점</div>
          <div>상태</div>
          <div className="text-right">관리</div>
        </div>

        {loading && <div className="px-6 py-8 text-[13px] text-[#A0AEC0]">담당자 목록 불러오는 중…</div>}
        {!loading && members.length === 0 && <div className="px-6 py-8 text-[13px] text-[#A0AEC0]">등록된 담당자가 없어요</div>}

        <div className="flex flex-col">
          {members.map((member) => (
            <div key={member.id} className="grid grid-cols-[2fr_1.5fr_1.5fr_1fr_0.5fr] items-center px-6 py-5 border-b border-[#F1F4F8] hover:bg-[#F7FAFC] transition-colors">
              <div className="flex flex-col">
                <div className="font-extrabold text-[#1A202C]">{member.name}</div>
                <div className="text-[12px] text-[#A0AEC0] flex items-center gap-1 mt-0.5"><Phone size={10} /> {member.phone || "연락처 없음"}</div>
              </div>

              <div>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-bold ${member.role === '마스터' || member.role === '본사' ? 'bg-[#EBF8FF] text-[#3182CE]' : 'bg-[#F1F4F8] text-[#4A5568]'}`}>
                  <Shield size={12} /> {member.role || "현장"}
                </span>
              </div>

              <div className="text-[13px] font-bold text-[#4A5568]">{member.branch || "전체"}</div>

              <div>
                <span className={`inline-flex px-2.5 py-1 rounded-md text-[12px] font-bold ${member.active ? 'bg-[#F0FFF4] text-[#38A169]' : 'bg-[#FFF5F5] text-[#E53E3E]'}`}>
                  {member.active ? '활성' : '비활성'}
                </span>
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
