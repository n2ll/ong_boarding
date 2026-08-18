import { useState, useEffect, useCallback, useMemo } from "react";
import useSWR from "swr";
import { useSearchParams, useRouter } from "next/navigation";
import { Search, Building2, Users, Briefcase, Plus, ArrowUpRight, AlertTriangle, Pencil, Trash2, X, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";
import { Modal } from "./ui/modal";
import { Button } from "./ui/button";
import { Field, TextField, TextareaField, SelectField, ToggleRow, controlBase } from "./ui/field";
import { cn } from "./ui/utils";
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
  // scope=rollup — 이 화면은 지원자를 나열하지 않고 숫자만 그린다. 이름·전화·주소를 받지 않는
  // 10컬럼 응답(gzip 85KB → 16KB)이고, 조립 조회 3개도 서버가 건너뛴다.
  // 리포트·슬롯보드·지점·자동화가 **같은 키**를 써야 SWR dedup이 유지된다.
  const { data: applicantsApi } = useSWR<{ data?: ApiApplicant[] }>("/api/admin/applicants?scope=rollup");
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
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          {!embedded && <h1 className="text-2xl font-extrabold text-foreground tracking-tight mb-1">지점 관리</h1>}
          <p className="text-[14px] text-muted-foreground">운영 중 {activeRows.length}개 · 전체 {rows.length}개 지점의 인력 현황과 정원을 관리합니다.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="지점명, 담당자 검색"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="bg-input-background/90 font-medium shadow-[var(--shadow-inset)] hover:border-foreground/25 min-h-11 pl-9 pr-4 py-2.5 border border-border-strong rounded-xl text-sm w-[280px] focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <button
            onClick={openCreate}
            className="flex items-center gap-2 bg-foreground hover:bg-gray-800 text-white px-5 py-2.5 rounded-xl font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus size={18} /> 신규 지점 등록
          </button>
        </div>
      </div>

      {/* Stats Summary */}
      <div className="flex flex-wrap gap-4 mb-8">
        <div className="flex-1 min-w-[220px] bg-card border border-border-strong rounded-2xl p-5 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-info-soft flex items-center justify-center shrink-0">
            <Building2 size={24} className="text-info-strong" />
          </div>
          <div>
            <div className="text-[13px] font-bold text-muted-foreground mb-0.5">운영 중인 지점</div>
            <div className="text-2xl font-extrabold text-foreground">{activeRows.length}<span className="text-sm font-medium text-muted-foreground ml-1">개</span></div>
          </div>
        </div>
        <div className="flex-1 min-w-[220px] bg-card border border-border-strong rounded-2xl p-5 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-error-soft flex items-center justify-center shrink-0">
            <AlertTriangle size={24} className="text-error-strong" />
          </div>
          <div>
            <div className="text-[13px] font-bold text-muted-foreground mb-0.5">인력 충원 시급 (충원율 70% 미만)</div>
            <div className="text-2xl font-extrabold text-error-strong">{criticalCount}<span className="text-sm font-medium text-muted-foreground ml-1">개 지점</span></div>
          </div>
        </div>
        <div className="flex-1 min-w-[220px] bg-card border border-border-strong rounded-2xl p-5 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-yellow-100 flex items-center justify-center shrink-0">
            <Briefcase size={24} className="text-warning-strong" />
          </div>
          <div>
            <div className="text-[13px] font-bold text-muted-foreground mb-0.5">진행 중인 공고</div>
            <div className="text-2xl font-extrabold text-foreground">{totalActiveJobs}<span className="text-sm font-medium text-muted-foreground ml-1">건</span></div>
          </div>
        </div>
      </div>

      {loading && <div className="text-[13px] text-muted-foreground py-8">지점 현황 불러오는 중…</div>}
      {!loading && rows.length === 0 && <div className="text-[13px] text-muted-foreground py-8">등록된 지점이 없어요</div>}

      {/* 화주사별 지점 그룹 */}
      <div className="flex flex-col gap-8">
        {groups.map((group) => (
          <section key={group.clientId ?? "none"}>
            <div className="flex items-center justify-between mb-3.5">
              <div className="flex items-center gap-2.5">
                <Building2 size={18} className={group.clientId == null ? "text-muted-foreground" : "text-info-strong"} />
                <h2 className="text-[16px] font-extrabold text-foreground">{group.name}</h2>
                <span className="text-[12px] font-bold text-muted-foreground bg-muted px-2.5 py-0.5 rounded-full">{group.branches.length}개 지점</span>
              </div>
              {group.clientId != null && (
                <button onClick={() => openCreateForClient(group.clientId)} className="min-h-11 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex items-center gap-1.5 text-[13px] font-bold text-info-strong hover:bg-info-soft px-3 py-1.5 rounded-lg transition-colors">
                  <Plus size={15} /> 이 화주사에 지점 추가
                </button>
              )}
            </div>
            {group.branches.length === 0 ? (
              <div className="bg-background border border-dashed border-border-strong rounded-2xl py-8 text-center text-[13px] text-muted-foreground">
                아직 등록된 지점이 없어요.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {group.branches.map((branch) => {
          const fillRatio = branch.fillRatio;
          return (
            <div key={branch.id} className={`bg-card border rounded-2xl p-6 transition-all group ${branch.active ? "border-border-strong hover:border-gray-300 hover:shadow-md" : "border-dashed border-border-strong opacity-70"}`}>
              <div className="flex justify-between items-start mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-muted-foreground">#{branch.id}</span>
                    {!branch.active && <span className="text-[11px] font-bold bg-muted text-muted-foreground px-2 py-0.5 rounded-full border border-gray-300">비활성</span>}
                    {branch.active && branch.status === 'critical' && <span className="text-[11px] font-bold bg-error-soft text-error-strong px-2 py-0.5 rounded-full border border-error/30">충원 시급</span>}
                    {branch.active && branch.status === 'warning' && <span className="text-[11px] font-bold bg-yellow-100 text-warning-strong px-2 py-0.5 rounded-full border border-yellow-300">충원 필요</span>}
                  </div>
                  <h3 className="text-[18px] font-extrabold text-foreground tracking-tight group-hover:text-info transition-colors">{branch.name}</h3>
                </div>
                <button onClick={() => openEdit(branch)} title="지점 편집" className="after:absolute after:-inset-2 after:content-[''] relative text-muted-foreground hover:text-foreground p-1.5 rounded-lg hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Pencil size={17} />
                </button>
              </div>

              <div className="flex flex-col gap-2 mb-6">
                <div className="flex items-center gap-2 text-[13px] text-gray-700">
                  <Users size={14} className="text-muted-foreground" /> {branch.manager}
                </div>
              </div>

              <div className="bg-background rounded-xl p-4 mb-4">
                <div className="flex justify-between items-end mb-2">
                  <span className="text-[12px] font-bold text-muted-foreground">인력 충원율</span>
                  <span className={`text-[16px] font-extrabold ${fillRatio < 70 ? 'text-error-strong' : fillRatio < 90 ? 'text-warning-strong' : 'text-success'}`}>
                    {branch.targetStaff > 0 ? `${fillRatio}%` : "정원 미설정"}
                  </span>
                </div>
                <div className="h-2 w-full bg-gray-200 rounded-full overflow-hidden mb-2">
                  <div
                    className={`h-full rounded-full ${fillRatio < 70 ? 'bg-error' : fillRatio < 90 ? 'bg-yellow-600' : 'bg-success'}`}
                    style={{ width: `${Math.min(fillRatio, 100)}%` }}
                  ></div>
                </div>
                <div className="text-[12px] text-muted-foreground text-right">
                  확정 <b className="text-gray-700">{branch.currentStaff}명</b> / 정원 {branch.targetStaff}명
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-muted pt-4">
                <div className="flex flex-wrap gap-4">
                  <div className="flex flex-col">
                    <span className="text-[11px] font-bold text-muted-foreground">진행 공고</span>
                    <span className="text-[14px] font-extrabold text-foreground">{branch.activeJobs}건</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[11px] font-bold text-muted-foreground">스크리닝 중</span>
                    <span className="text-[14px] font-extrabold text-info">{branch.applications}명</span>
                  </div>
                </div>
                <button
                  onClick={() => openEdit(branch)}
                  className="flex items-center gap-1 text-[13px] font-bold text-foreground bg-brand-yellow hover:bg-yellow-500 px-3 py-1.5 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
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
      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        busy={saving}
        size="lg"
        title={form?.id === null ? "신규 지점 등록" : "지점 편집"}
        description="이름만 넣어도 저장됩니다. 정원·AI 정보는 저장 후에 채울 수 있습니다."
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            {form?.id !== null && form ? (
              <Button variant="ghost" size="sm" onClick={handleDelete} disabled={saving} className="text-error-strong hover:bg-error-soft">
                <Trash2 size={15} /> 삭제
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setForm(null)} disabled={saving}>취소</Button>
              <Button size="sm" onClick={handleSave} isLoading={saving}>
                <Save size={15} /> 저장
              </Button>
            </div>
          </div>
        }
      >
        {form && (
          <div className="flex flex-col gap-4">
            <TextField
              required
              label="지점 이름"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="예: 강북미아"
            />

            <SelectField
              label="소속 화주사"
              value={form.clientId ?? ""}
              onChange={(e) => setForm({ ...form, clientId: e.target.value ? Number(e.target.value) : null })}
              hint={clients.length === 0 ? "먼저 \u2018화주사\u2019 화면에서 화주사를 등록하면 여기서 선택할 수 있어요." : undefined}
            >
              <option value="">미지정</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectField>

            <ToggleRow
              label="활성 상태"
              description="끄면 지원 폼(/apply)에서 숨겨집니다. 어드민에는 계속 표시됩니다."
              checked={form.active}
              onChange={(v) => setForm({ ...form, active: v })}
            />

            {form.id !== null && (
              <>
                {/* 슬롯별 정원은 비마트식 슬롯 구인(uses_slots) 화주사만 — 도시락 등 비슬롯 라인은 숨김. */}
                {formClientUsesSlots && (
                  <Field
                    label="슬롯별 정원"
                    hint="확정 슬롯 매트릭스의 정원으로 쓰입니다. 슬롯 구인을 안 하는 지점은 0으로 두면 충원율 계산에서 제외됩니다."
                  >
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      {SLOTS.map((s: SlotKey) => (
                        <label key={s} className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-border-strong bg-input-background/70 px-3.5 py-2">
                          <span className="text-[13px] font-bold text-foreground">{s}</span>
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
                            className={cn(controlBase, "h-9 w-20 shrink-0 px-2 py-1 text-right")}
                          />
                        </label>
                      ))}
                    </div>
                  </Field>
                )}

                <TextareaField
                  label="AI 참고 정보 (운영 정보)"
                  rows={3}
                  value={form.aiFacts}
                  onChange={(e) => setForm({ ...form, aiFacts: e.target.value })}
                  placeholder="이 지점 지원자 응대 시 AI가 참고할 정보. 예: 픽업 위치, 시급, 특이사항. 비우면 공통 운영 정보만 사용합니다."
                />
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
