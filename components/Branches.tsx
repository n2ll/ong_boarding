import { useState, useEffect, useCallback, useMemo } from "react";
import useSWR from "swr";
import { useSearchParams, useRouter } from "next/navigation";
import { Search, Building2, Users, Briefcase, Plus, ArrowUpRight, AlertTriangle, Pencil, Trash2, X, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";
import { SLOTS, DEFAULT_SLOT_CAPACITY, type SlotKey } from "@/lib/admin/types";

interface ApiBranch {
  id: number;
  name: string;
  active: boolean;
  client_id: number | null;
  slot_capacity: Record<string, number> | null;
  ai_facts?: string | null;
}

interface ClientOption {
  id: number;
  name: string;
  uses_slots?: boolean;
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
  active: boolean;
  clientId: number | null;
  slotCapacity: Record<string, number>;
  aiFacts: string;
  manager: string;
  currentStaff: number;
  targetStaff: number;
  activeJobs: number;
  applications: number;
  fillRatio: number;
  status: "good" | "warning" | "critical";
}

interface BranchForm {
  id: number | null;
  name: string;
  active: boolean;
  clientId: number | null;
  slotCapacity: Record<string, number>;
  aiFacts: string;
}

function emptyForm(clientId: number | null): BranchForm {
  return {
    id: null,
    name: "",
    active: true,
    clientId,
    slotCapacity: { ...DEFAULT_SLOT_CAPACITY },
    aiFacts: "",
  };
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

export function Branches({ embedded = false }: { embedded?: boolean } = {}) {
  const confirm = useConfirm();
  const [searchTerm, setSearchTerm] = useState("");
  const [form, setForm] = useState<BranchForm | null>(null);
  const [saving, setSaving] = useState(false);

  // 지점 현황은 5종 데이터 조합 — 모두 SWR로 캐시·dedup(타 탭과 키 공유). rows는 파생 계산.
  const { data: branchesApi, isLoading, mutate: mutateBranches } = useSWR<{ data?: ApiBranch[] }>("/api/admin/branches");
  const { data: applicantsApi } = useSWR<{ data?: ApiApplicant[] }>("/api/admin/applicants");
  const { data: jobsApi } = useSWR<{ jobs?: ApiJob[] }>("/api/admin/jobs?status=all");
  const { data: managersApi } = useSWR<{ data?: ApiManager[] }>("/api/admin/site-managers");
  const { data: clientsApi } = useSWR<{ data?: ClientOption[] }>("/api/admin/clients");

  const clients = useMemo(() => (clientsApi?.data ?? []).map((c) => ({ id: c.id, name: c.name, uses_slots: c.uses_slots ?? false })), [clientsApi]);
  // 편집 중인 지점의 화주사가 슬롯 구인을 쓰는지 — 슬롯 정원 편집기는 이 경우만 노출(비마트식 슬롯 전용).
  const formClientUsesSlots = useMemo(
    () => (form ? clients.find((c) => c.id === form.clientId)?.uses_slots ?? false : false),
    [form, clients]
  );
  const loading = isLoading && (branchesApi?.data?.length ?? 0) === 0;
  // 지점 추가/수정 후 목록 갱신은 지점 키만 재검증하면 충분(파생 계산이 자동 반영).
  const loadBranches = useCallback(() => { void mutateBranches(); }, [mutateBranches]);

  const rows = useMemo<BranchRow[]>(() => {
    const branches = branchesApi?.data ?? [];
    const applicants = applicantsApi?.data ?? [];
    const jobs = jobsApi?.jobs ?? [];
    const managers = managersApi?.data ?? [];
    return branches.map((b) => {
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
        active: b.active,
        clientId: b.client_id ?? null,
        slotCapacity: (b.slot_capacity ?? {}) as Record<string, number>,
        aiFacts: b.ai_facts ?? "",
        manager: mgr?.name ? `${mgr.name} 담당` : "담당자 미지정",
        currentStaff,
        targetStaff,
        activeJobs,
        applications,
        fillRatio,
        status,
      };
    });
  }, [branchesApi, applicantsApi, jobsApi, managersApi]);

  const openCreate = () => setForm(emptyForm(clients[0]?.id ?? null));
  const openCreateForClient = (clientId: number | null) => setForm(emptyForm(clientId));

  // 화주사 관리에서 '이 화주사에 지점 추가'로 진입(?client=ID)하면 생성 폼 자동 오픈
  const searchParams = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    const cid = searchParams.get("client");
    if (cid && /^\d+$/.test(cid)) {
      setForm(emptyForm(Number(cid)));
      router.replace("/branches");
    }
  }, [searchParams, router]);
  const openEdit = (b: BranchRow) =>
    setForm({
      id: b.id,
      name: b.name,
      active: b.active,
      clientId: b.clientId,
      slotCapacity: SLOTS.reduce((acc, s) => {
        acc[s] = typeof b.slotCapacity[s] === "number" ? b.slotCapacity[s] : DEFAULT_SLOT_CAPACITY[s];
        return acc;
      }, {} as Record<string, number>),
      aiFacts: b.aiFacts,
    });

  const handleSave = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) return toast.error("지점 이름을 입력해주세요.");
    setSaving(true);
    try {
      const isEdit = form.id !== null;
      const res = await fetch(
        isEdit ? `/api/admin/branches/${form.id}` : "/api/admin/branches",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isEdit
              ? { name, active: form.active, client_id: form.clientId, slot_capacity: form.slotCapacity, ai_facts: form.aiFacts.trim() || null }
              : { name, active: form.active, client_id: form.clientId }
          ),
        }
      );
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "저장에 실패했어요");
        return;
      }
      toast.success(isEdit ? "지점 정보를 수정했어요." : "새 지점을 등록했어요.");
      setForm(null);
      await loadBranches();
    } catch {
      toast.error("저장에 실패했어요");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!form || form.id === null) return;
    if (!(await confirm({ title: "지점을 삭제할까요?", description: `'${form.name}' 지점을 삭제합니다. 소속 지원자가 있으면 비활성 처리됩니다.`, confirmText: "삭제", destructive: true }))) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/branches/${form.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "삭제에 실패했어요");
        return;
      }
      toast.success(json.soft ? json.message || "지점을 비활성화했어요." : "지점을 삭제했어요.");
      setForm(null);
      await loadBranches();
    } catch {
      toast.error("삭제에 실패했어요");
    } finally {
      setSaving(false);
    }
  };

  const filteredBranches = rows.filter(
    (b) => b.name.includes(searchTerm) || b.manager.includes(searchTerm)
  );

  const activeRows = rows.filter((b) => b.active);
  const criticalCount = activeRows.filter((b) => b.status === "critical").length;
  const totalActiveJobs = activeRows.reduce((a, b) => a + b.activeJobs, 0);

  // 화주사 단위 그룹핑 — 각 화주사 + 미지정 섹션
  const groups: { clientId: number | null; name: string; branches: BranchRow[] }[] = [
    ...clients.map((c) => ({
      clientId: c.id,
      name: c.name,
      branches: filteredBranches.filter((b) => b.clientId === c.id),
    })),
    {
      clientId: null,
      name: "화주사 미지정",
      branches: filteredBranches.filter((b) => b.clientId == null),
    },
  ].filter((g) => g.branches.length > 0 || g.clientId !== null);

  return (
    <div className={embedded ? "flex flex-col" : "p-8 pb-12 flex flex-col h-full overflow-y-auto"}>
      {/* Header & Tools */}
      <div className="flex items-center justify-between mb-6">
        <div>
          {!embedded && <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">지점 관리</h1>}
          <p className="text-[14px] text-[#718096]">운영 중 {activeRows.length}개 · 전체 {rows.length}개 지점의 인력 현황과 정원을 관리합니다.</p>
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
            onClick={openCreate}
            className="flex items-center gap-2 bg-[#1A202C] hover:bg-[#2D3748] text-white px-5 py-2.5 rounded-xl font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
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
            <div className="text-2xl font-extrabold text-[#1A202C]">{activeRows.length}<span className="text-sm font-medium text-[#718096] ml-1">개</span></div>
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

      {/* 화주사별 지점 그룹 */}
      <div className="flex flex-col gap-8">
        {groups.map((group) => (
          <section key={group.clientId ?? "none"}>
            <div className="flex items-center justify-between mb-3.5">
              <div className="flex items-center gap-2.5">
                <Building2 size={18} className={group.clientId == null ? "text-[#A0AEC0]" : "text-[#3182CE]"} />
                <h2 className="text-[16px] font-extrabold text-[#1A202C]">{group.name}</h2>
                <span className="text-[12px] font-bold text-[#718096] bg-[#EDF2F7] px-2.5 py-0.5 rounded-full">{group.branches.length}개 지점</span>
              </div>
              {group.clientId != null && (
                <button onClick={() => openCreateForClient(group.clientId)} className="flex items-center gap-1.5 text-[12.5px] font-bold text-[#3182CE] hover:bg-[#EBF8FF] px-3 py-1.5 rounded-lg transition-colors">
                  <Plus size={15} /> 이 화주사에 지점 추가
                </button>
              )}
            </div>
            {group.branches.length === 0 ? (
              <div className="bg-[#F7FAFC] border border-dashed border-[#E2E8F0] rounded-2xl py-8 text-center text-[13px] text-[#A0AEC0]">
                아직 등록된 지점이 없어요.
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-6">
                {group.branches.map((branch) => {
          const fillRatio = branch.fillRatio;
          return (
            <div key={branch.id} className={`bg-white border rounded-2xl p-6 transition-all group ${branch.active ? "border-[#E2E8F0] hover:border-[#CBD5E0] hover:shadow-md" : "border-dashed border-[#E2E8F0] opacity-70"}`}>
              <div className="flex justify-between items-start mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-[#A0AEC0]">#{branch.id}</span>
                    {!branch.active && <span className="text-[10px] font-bold bg-[#EDF2F7] text-[#718096] px-2 py-0.5 rounded border border-[#CBD5E0]">비활성</span>}
                    {branch.active && branch.status === 'critical' && <span className="text-[10px] font-bold bg-[#FFF5F5] text-[#E53E3E] px-2 py-0.5 rounded border border-[#FEB2B2]">충원 시급</span>}
                    {branch.active && branch.status === 'warning' && <span className="text-[10px] font-bold bg-[#FEFCBF] text-[#D69E2E] px-2 py-0.5 rounded border border-[#F6E05E]">충원 필요</span>}
                  </div>
                  <h3 className="text-[18px] font-extrabold text-[#1A202C] tracking-tight group-hover:text-[#3182CE] transition-colors">{branch.name}</h3>
                </div>
                <button onClick={() => openEdit(branch)} title="지점 편집" className="text-[#A0AEC0] hover:text-[#1A202C] p-1.5 rounded-lg hover:bg-[#F7FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
                  <Pencil size={17} />
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
                  onClick={() => openEdit(branch)}
                  className="flex items-center gap-1 text-[13px] font-bold text-[#1A202C] bg-[#FFCB3C] hover:bg-[#E0B500] px-3 py-1.5 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1A202C]"
                >
                  정원 · 편집 <ArrowUpRight size={14} />
                </button>
              </div>
            </div>
          );
                })}
              </div>
            )}
          </section>
        ))}
      </div>

      {/* 생성 / 편집 모달 */}
      {form && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => !saving && setForm(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#E2E8F0] sticky top-0 bg-white">
              <h2 className="text-[18px] font-extrabold text-[#1A202C]">{form.id === null ? "신규 지점 등록" : "지점 편집"}</h2>
              <button onClick={() => setForm(null)} className="text-[#A0AEC0] hover:text-[#4A5568] p-1 rounded-lg"><X size={20} /></button>
            </div>
            <div className="p-6 flex flex-col gap-5">
              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">지점 이름 <span className="text-[#E53E3E]">*</span></label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="예: 강북미아"
                  className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
                />
              </div>

              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">소속 화주사</label>
                <select
                  value={form.clientId ?? ""}
                  onChange={(e) => setForm({ ...form, clientId: e.target.value ? Number(e.target.value) : null })}
                  className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
                >
                  <option value="">미지정</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {clients.length === 0 && (
                  <p className="text-[11.5px] text-[#A0AEC0] mt-1.5">먼저 화주사 관리에서 화주사를 등록하면 여기서 선택할 수 있어요.</p>
                )}
              </div>

              <div className="flex items-center justify-between p-4 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl">
                <div>
                  <div className="text-[14px] font-bold text-[#1A202C]">활성 상태</div>
                  <div className="text-[12px] text-[#718096] mt-0.5">비활성 시 지원 폼(/apply)에서 숨겨집니다. 어드민에는 계속 표시됩니다.</div>
                </div>
                <button
                  onClick={() => setForm({ ...form, active: !form.active })}
                  className={`w-12 h-7 rounded-full relative transition-colors shrink-0 ${form.active ? "bg-[#38A169]" : "bg-[#CBD5E0]"}`}
                >
                  <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform ${form.active ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>

              {form.id !== null && (
                <>
                  {/* 슬롯별 정원은 비마트식 슬롯 구인(uses_slots) 화주사만 — 도시락 등 비슬롯 라인은 숨김. */}
                  {formClientUsesSlots && (
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">슬롯별 정원</label>
                    <div className="grid grid-cols-2 gap-3">
                      {SLOTS.map((s: SlotKey) => (
                        <div key={s} className="flex items-center justify-between bg-white border border-[#E2E8F0] rounded-xl px-3.5 py-2.5">
                          <span className="text-[13px] font-bold text-[#4A5568]">{s}</span>
                          <input
                            type="number"
                            min={0}
                            value={form.slotCapacity[s] ?? 0}
                            onChange={(e) =>
                              setForm({
                                ...form,
                                slotCapacity: { ...form.slotCapacity, [s]: Math.max(0, Number(e.target.value) || 0) },
                              })
                            }
                            onFocus={(e) => e.target.select()}
                            className="w-16 px-2 py-1 border border-[#E2E8F0] rounded-lg text-sm text-right focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
                          />
                        </div>
                      ))}
                    </div>
                    <p className="text-[11.5px] text-[#A0AEC0] mt-2">확정 슬롯 매트릭스의 정원으로 쓰입니다. 슬롯 구인을 안 하는 지점은 0으로 두면 충원율 계산에서 제외됩니다.</p>
                  </div>
                  )}

                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">AI 참고 정보 (운영 정보)</label>
                    <textarea
                      value={form.aiFacts}
                      onChange={(e) => setForm({ ...form, aiFacts: e.target.value })}
                      rows={3}
                      placeholder="이 지점 지원자 응대 시 AI가 참고할 정보. 예: 픽업 위치, 시급, 특이사항. 비우면 공통 운영 정보만 사용합니다."
                      className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none"
                    />
                  </div>
                </>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-[#E2E8F0] sticky bottom-0 bg-white">
              <div>
                {form.id !== null && (
                  <button onClick={handleDelete} disabled={saving} className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-bold text-[#E53E3E] hover:bg-[#FFF5F5] border border-[#FEB2B2] disabled:opacity-50">
                    <Trash2 size={15} /> 삭제
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setForm(null)} disabled={saving} className="px-4 py-2.5 rounded-xl text-[13px] font-bold text-[#718096] hover:bg-[#F7FAFC] border border-[#E2E8F0] disabled:opacity-50">취소</button>
                <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-[13px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] disabled:opacity-60">
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} 저장
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
