import { useState, useEffect } from "react";
import { Search, MapPin, Building2, Users, Briefcase, Plus, MoreHorizontal, ArrowUpRight, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface ApiBranch {
  id: number;
  name: string;
  active: boolean;
  slot_capacity: Record<string, number> | null;
}

interface ApiApplicant {
  status: string;
  branch?: string | null;
  branch1?: string | null;
  confirmed_branch?: string | null;
  current_branch?: string | null;
}

interface ApiJob {
  branch: string | null;
  status: string;
}

interface ApiManager {
  name: string;
  branch: string | null;
  active: boolean;
}

interface BranchRow {
  id: number;
  name: string;
  manager: string;
  currentStaff: number;
  targetStaff: number;
  activeJobs: number;
  applications: number;
  fillRatio: number;
  status: "good" | "warning" | "critical";
}

const SCREENING_STATUSES = new Set(["스크리닝 전", "스크리닝 중", "스크리닝 완료"]);

function belongsToBranch(a: ApiApplicant, name: string): boolean {
  return (
    a.branch === name ||
    a.branch1 === name ||
    a.current_branch === name ||
    (a.confirmed_branch ?? "").split(",").map((s) => s.trim()).includes(name)
  );
}

function sumCapacity(cap: Record<string, number> | null): number {
  if (!cap || typeof cap !== "object") return 0;
  return Object.values(cap).reduce((acc, v) => acc + (typeof v === "number" ? v : 0), 0);
}

export function Branches() {
  const [rows, setRows] = useState<BranchRow[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [bRes, aRes, jRes, mRes] = await Promise.all([
          fetch("/api/admin/branches"),
          fetch("/api/admin/applicants"),
          fetch("/api/admin/jobs?status=all"),
          fetch("/api/admin/site-managers"),
        ]);
        const branches = ((await bRes.json()).data ?? []) as ApiBranch[];
        const applicants = ((await aRes.json()).data ?? []) as ApiApplicant[];
        const jobs = ((await jRes.json()).jobs ?? []) as ApiJob[];
        const managers = ((await mRes.json()).data ?? []) as ApiManager[];

        const computed: BranchRow[] = branches
          .filter((b) => b.active)
          .map((b) => {
            const mine = applicants.filter((a) => belongsToBranch(a, b.name));
            const currentStaff = mine.filter((a) => a.status === "확정인력").length;
            const applications = mine.filter((a) => SCREENING_STATUSES.has(a.status)).length;
            const activeJobs = jobs.filter((j) => j.branch === b.name && j.status !== "closed").length;
            const targetStaff = sumCapacity(b.slot_capacity);
            const fillRatio = targetStaff > 0 ? Math.round((currentStaff / targetStaff) * 100) : 100;
            const status: BranchRow["status"] =
              targetStaff === 0 ? "good" : fillRatio < 70 ? "critical" : fillRatio < 90 ? "warning" : "good";
            const mgr = managers.find((m) => m.active && m.branch === b.name);
            return {
              id: b.id,
              name: b.name,
              manager: mgr?.name ? `${mgr.name} 담당` : "담당자 미지정",
              currentStaff,
              targetStaff,
              activeJobs,
              applications,
              fillRatio,
              status,
            };
          });
        setRows(computed);
      } catch {
        toast.error("지점 현황을 불러오지 못했어요");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filteredBranches = rows.filter(
    (b) => b.name.includes(searchTerm) || b.manager.includes(searchTerm)
  );

  const criticalCount = rows.filter((b) => b.status === "critical").length;
  const totalActiveJobs = rows.reduce((a, b) => a + b.activeJobs, 0);

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      {/* Header & Tools */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">지점 관리</h1>
          <p className="text-[14px] text-[#718096]">총 {rows.length}개 지점의 인력 현황과 채용을 관리합니다.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
            <input
              type="text"
              placeholder="지점명, 담당자 검색"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 pr-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm w-[280px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
            />
          </div>
          <button
            onClick={() => toast.info("신규 지점 등록은 준비 중이에요")}
            className="flex items-center gap-2 bg-[#1A202C] hover:bg-[#2D3748] text-white px-5 py-2.5 rounded-xl font-bold transition-colors"
          >
            <Plus size={18} /> 신규 지점 등록
          </button>
        </div>
      </div>

      {/* Stats Summary */}
      <div className="flex gap-4 mb-8">
        <div className="flex-1 bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-[#EBF8FF] flex items-center justify-center shrink-0">
            <Building2 size={24} className="text-[#3182CE]" />
          </div>
          <div>
            <div className="text-[13px] font-bold text-[#718096] mb-0.5">운영 중인 지점</div>
            <div className="text-2xl font-extrabold text-[#1A202C]">{rows.length}<span className="text-sm font-medium text-[#718096] ml-1">개</span></div>
          </div>
        </div>
        <div className="flex-1 bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-[#FFF5F5] flex items-center justify-center shrink-0">
            <AlertTriangle size={24} className="text-[#E53E3E]" />
          </div>
          <div>
            <div className="text-[13px] font-bold text-[#718096] mb-0.5">인력 충원 시급 (충원율 70% 미만)</div>
            <div className="text-2xl font-extrabold text-[#E53E3E]">{criticalCount}<span className="text-sm font-medium text-[#718096] ml-1">개 지점</span></div>
          </div>
        </div>
        <div className="flex-1 bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-[#FEFCBF] flex items-center justify-center shrink-0">
            <Briefcase size={24} className="text-[#D69E2E]" />
          </div>
          <div>
            <div className="text-[13px] font-bold text-[#718096] mb-0.5">진행 중인 공고</div>
            <div className="text-2xl font-extrabold text-[#1A202C]">{totalActiveJobs}<span className="text-sm font-medium text-[#718096] ml-1">건</span></div>
          </div>
        </div>
      </div>

      {loading && <div className="text-[13px] text-[#A0AEC0] py-8">지점 현황 불러오는 중…</div>}
      {!loading && rows.length === 0 && <div className="text-[13px] text-[#A0AEC0] py-8">등록된 지점이 없어요</div>}

      {/* Grid of Branches */}
      <div className="grid grid-cols-3 gap-6">
        {filteredBranches.map((branch) => {
          const fillRatio = branch.fillRatio;
          return (
            <div key={branch.id} className="bg-white border border-[#E2E8F0] hover:border-[#CBD5E0] hover:shadow-md rounded-2xl p-6 transition-all group">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-[#A0AEC0]">#{branch.id}</span>
                    {branch.status === 'critical' && <span className="text-[10px] font-bold bg-[#FFF5F5] text-[#E53E3E] px-2 py-0.5 rounded border border-[#FEB2B2]">충원 시급</span>}
                    {branch.status === 'warning' && <span className="text-[10px] font-bold bg-[#FEFCBF] text-[#D69E2E] px-2 py-0.5 rounded border border-[#F6E05E]">충원 필요</span>}
                  </div>
                  <h3 className="text-[18px] font-extrabold text-[#1A202C] tracking-tight group-hover:text-[#3182CE] transition-colors">{branch.name}</h3>
                </div>
                <button className="text-[#A0AEC0] hover:text-[#4A5568]">
                  <MoreHorizontal size={20} />
                </button>
              </div>

              <div className="flex flex-col gap-2 mb-6">
                <div className="flex items-center gap-2 text-[13px] text-[#4A5568]">
                  <Users size={14} className="text-[#A0AEC0]" /> {branch.manager}
                </div>
              </div>

              <div className="bg-[#F7FAFC] rounded-xl p-4 mb-4">
                <div className="flex justify-between items-end mb-2">
                  <span className="text-[12px] font-bold text-[#718096]">인력 충원율</span>
                  <span className={`text-[15px] font-extrabold ${fillRatio < 70 ? 'text-[#E53E3E]' : fillRatio < 90 ? 'text-[#D69E2E]' : 'text-[#38A169]'}`}>
                    {branch.targetStaff > 0 ? `${fillRatio}%` : "정원 미설정"}
                  </span>
                </div>
                <div className="h-2 w-full bg-[#E2E8F0] rounded-full overflow-hidden mb-2">
                  <div
                    className={`h-full rounded-full ${fillRatio < 70 ? 'bg-[#E53E3E]' : fillRatio < 90 ? 'bg-[#D69E2E]' : 'bg-[#38A169]'}`}
                    style={{ width: `${Math.min(fillRatio, 100)}%` }}
                  ></div>
                </div>
                <div className="text-[11.5px] text-[#A0AEC0] text-right">
                  확정 <b className="text-[#4A5568]">{branch.currentStaff}명</b> / 정원 {branch.targetStaff}명
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-[#F1F4F8] pt-4">
                <div className="flex gap-4">
                  <div className="flex flex-col">
                    <span className="text-[11px] font-bold text-[#A0AEC0]">진행 공고</span>
                    <span className="text-[14px] font-extrabold text-[#1A202C]">{branch.activeJobs}건</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[11px] font-bold text-[#A0AEC0]">스크리닝 중</span>
                    <span className="text-[14px] font-extrabold text-[#3182CE]">{branch.applications}명</span>
                  </div>
                </div>
                <button
                  onClick={() => toast.info(`${branch.name} 상세는 준비 중이에요`)}
                  className="flex items-center gap-1 text-[13px] font-bold text-[#1A202C] bg-[#FFCB3C] hover:bg-[#E0B500] px-3 py-1.5 rounded-lg transition-colors"
                >
                  상세 보기 <ArrowUpRight size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
