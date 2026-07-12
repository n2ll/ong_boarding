import { useState, useEffect, useCallback, useMemo } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { Building2, Plus, Search, Pencil, Trash2, X, Loader2, Save, Clock4, ChevronRight, MapPin } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";
import { CLIENT_TYPE_LABEL, type ClientType } from "@/lib/admin/types";

interface BranchLite { id: number; name: string; active: boolean; client_id: number | null }

interface ApiClient {
  id: number;
  name: string;
  client_type: ClientType;
  uses_slots: boolean;
  contact_name: string | null;
  contact_phone: string | null;
  memo: string | null;
  active: boolean;
  sort_order: number;
  branches_count: number;
  active_jobs: number;
}

interface ClientForm {
  id: number | null;
  name: string;
  client_type: ClientType;
  uses_slots: boolean;
  contact_name: string;
  contact_phone: string;
  memo: string;
  active: boolean;
}

interface IntegrityReport {
  jobs_total: number;
  jobs_linked: number;
  jobs_backfillable: number;
  jobs_unmatched: number;
  jobs_missing_client: number;
  branches_total: number;
  branches_missing_client: number;
}

const TYPE_OPTIONS: ClientType[] = ["baemin_bmart", "danggeun", "general"];

function emptyForm(): ClientForm {
  return {
    id: null,
    name: "",
    client_type: "general",
    uses_slots: false,
    contact_name: "",
    contact_phone: "",
    memo: "",
    active: true,
  };
}

export function Clients() {
  const router = useRouter();
  const confirm = useConfirm();
  // 화주사 목록은 SWR로 — 탭 재방문 시 즉시 표시. 변경 후 갱신은 load(=mutate)로.
  const { data: clientsApi, isLoading, mutate: mutateClients } = useSWR<{ data?: ApiClient[] }>("/api/admin/clients");
  const clients = useMemo(() => clientsApi?.data ?? [], [clientsApi]);
  const loading = isLoading && clients.length === 0;
  const load = useCallback(() => { void mutateClients(); }, [mutateClients]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<ClientForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // 지점 목록(읽기 전용 표시) — 타 탭과 동일 키라 dedup.
  const { data: branchesApi } = useSWR<{ data?: BranchLite[] }>("/api/admin/branches");
  const branches = useMemo(() => branchesApi?.data ?? [], [branchesApi]);

  // 데이터 정합성 점검 (5-a) — 첫 로드는 SWR, 재백필 결과는 로컬에서 갱신.
  const { data: integApi } = useSWR<{ report?: IntegrityReport }>("/api/admin/data-integrity");
  const [integ, setInteg] = useState<IntegrityReport | null>(null);
  const [integRunning, setIntegRunning] = useState(false);
  useEffect(() => {
    if (integApi?.report) setInteg(integApi.report);
  }, [integApi]);

  const runBackfill = async () => {
    if (integRunning) return;
    setIntegRunning(true);
    try {
      const res = await fetch("/api/admin/data-integrity", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "재백필에 실패했어요");
        return;
      }
      setInteg(json.report as IntegrityReport);
      const f = json.fixed ?? {};
      const total = (f.jobs_branch ?? 0) + (f.jobs_client ?? 0) + (f.branches_client ?? 0);
      toast.success(total > 0 ? `정합성 ${total}건을 자동 연결했어요.` : "이미 모두 정합 상태예요.");
    } catch {
      toast.error("재백필에 실패했어요");
    } finally {
      setIntegRunning(false);
    }
  };

  const addBranchForClient = (clientId: number) => router.push(`/branches?client=${clientId}`);

  const openCreate = () => setForm(emptyForm());
  const openEdit = (c: ApiClient) =>
    setForm({
      id: c.id,
      name: c.name,
      client_type: c.client_type,
      uses_slots: c.uses_slots,
      contact_name: c.contact_name ?? "",
      contact_phone: c.contact_phone ?? "",
      memo: c.memo ?? "",
      active: c.active,
    });

  const handleSave = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) return toast.error("화주사 이름을 입력해주세요.");
    setSaving(true);
    try {
      const isEdit = form.id !== null;
      const payload = {
        name,
        client_type: form.client_type,
        uses_slots: form.uses_slots,
        contact_name: form.contact_name.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        memo: form.memo.trim() || null,
        active: form.active,
      };
      const res = await fetch(
        isEdit ? `/api/admin/clients/${form.id}` : "/api/admin/clients",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "저장에 실패했어요");
        return;
      }
      toast.success(isEdit ? "화주사 정보를 수정했어요." : "새 화주사를 등록했어요.");
      setForm(null);
      await load();
    } catch {
      toast.error("저장에 실패했어요");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!form || form.id === null) return;
    if (!(await confirm({ title: "화주사를 삭제할까요?", description: `'${form.name}' 화주사를 삭제합니다. 소속 지점이 있으면 비활성 처리됩니다.`, confirmText: "삭제", destructive: true }))) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/clients/${form.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "삭제에 실패했어요");
        return;
      }
      toast.success(json.soft ? json.message || "비활성화했어요." : "삭제했어요.");
      setForm(null);
      await load();
    } catch {
      toast.error("삭제에 실패했어요");
    } finally {
      setSaving(false);
    }
  };

  const filtered = clients.filter((c) => c.name.includes(search) || (c.contact_name ?? "").includes(search));
  const activeCount = clients.filter((c) => c.active).length;

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">화주사 관리</h1>
          <p className="text-[14px] text-[#718096]">화주사(고객사)별로 소속 지점과 공고를 묶어 관리합니다. 운영 중 {activeCount}곳 · 전체 {clients.length}곳.</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-[#1A202C] hover:bg-[#2D3748] text-white px-5 py-2.5 rounded-xl font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
        >
          <Plus size={18} /> 신규 화주사 등록
        </button>
      </div>

      {integ && (
        <div className="mb-6 bg-white border border-[#E2E8F0] rounded-2xl shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-bold text-[#1A202C]">데이터 정합성 점검</span>
              {integ.jobs_backfillable + integ.jobs_missing_client + integ.branches_missing_client > 0 ? (
                <span className="text-[11px] font-bold text-[#DD6B20] bg-[#FFFAF0] border border-[#FBD38D] px-2 py-0.5 rounded-full">자동 연결 가능 항목 있음</span>
              ) : (
                <span className="text-[11px] font-bold text-[#38A169] bg-[#F0FFF4] border border-[#C6F6D5] px-2 py-0.5 rounded-full">정합 상태</span>
              )}
            </div>
            <button
              onClick={runBackfill}
              disabled={integRunning}
              className="flex items-center gap-1.5 bg-white border border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC] px-3.5 py-1.5 rounded-lg text-[12.5px] font-bold transition-colors disabled:opacity-60"
            >
              {integRunning ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 재백필 실행
            </button>
          </div>
          <div className="grid grid-cols-5 gap-3 text-center">
            {[
              { label: "공고 연결됨", value: `${integ.jobs_linked}/${integ.jobs_total}`, warn: false },
              { label: "자동 연결 가능", value: integ.jobs_backfillable, warn: integ.jobs_backfillable > 0 },
              { label: "미매칭 공고", value: integ.jobs_unmatched, warn: integ.jobs_unmatched > 0 },
              { label: "화주사 누락 공고", value: integ.jobs_missing_client, warn: integ.jobs_missing_client > 0 },
              { label: "화주사 누락 지점", value: integ.branches_missing_client, warn: integ.branches_missing_client > 0 },
            ].map((m) => (
              <div key={m.label} className={`rounded-xl border px-2 py-2.5 ${m.warn ? "border-[#FBD38D] bg-[#FFFAF0]" : "border-[#E2E8F0] bg-[#FCFDFE]"}`}>
                <div className={`text-[18px] font-extrabold ${m.warn ? "text-[#DD6B20]" : "text-[#1A202C]"}`}>{m.value}</div>
                <div className="text-[11px] font-bold text-[#718096] mt-0.5">{m.label}</div>
              </div>
            ))}
          </div>
          <p className="text-[11.5px] text-[#A0AEC0] mt-3">‘재백필 실행’은 지점명 매칭으로 공고·지점의 화주사/지점 연결만 채웁니다. 기존 데이터를 삭제하지 않으며, 미매칭 공고는 지점명을 확인해 수정해주세요.</p>
        </div>
      )}

      <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-sm overflow-hidden flex flex-col">
        <div className="p-5 border-b border-[#E2E8F0] flex items-center justify-between">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="기업명·담당자 검색"
              className="pl-9 pr-4 py-2 border border-[#E2E8F0] rounded-xl text-sm w-[260px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
            />
          </div>
        </div>

        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_0.5fr] items-center px-6 py-3.5 border-b border-[#E2E8F0] bg-[#F7FAFC] text-[13px] font-bold text-[#718096]">
          <div>화주사 명</div>
          <div>유형 / 슬롯</div>
          <div>등록 지점 수</div>
          <div>진행 공고 수</div>
          <div>담당자</div>
          <div className="text-right">관리</div>
        </div>

        {loading && <div className="px-6 py-10 text-[13px] text-[#A0AEC0]">불러오는 중…</div>}
        {!loading && filtered.length === 0 && (
          <div className="px-6 py-10 text-center text-[13px] text-[#A0AEC0]">
            {search ? `'${search}' 검색 결과가 없어요.` : (
              <>등록된 화주사가 없어요. <button onClick={openCreate} className="text-[#3182CE] font-bold hover:underline">신규 등록</button>으로 시작하세요.</>
            )}
          </div>
        )}

        <div className="flex flex-col">
          {filtered.map((client) => {
            const myBranches = branches.filter((b) => b.client_id === client.id);
            const expanded = expandedId === client.id;
            return (
            <div key={client.id} className={`border-b border-[#F1F4F8] ${client.active ? "" : "opacity-60"}`}>
              <div className={`grid grid-cols-[2fr_1fr_1fr_1fr_1fr_0.5fr] items-center px-6 py-5 hover:bg-[#F7FAFC] transition-colors cursor-pointer ${expanded ? "bg-[#F7FAFC]" : ""}`} onClick={() => setExpandedId(expanded ? null : client.id)}>
              <div className="flex items-center gap-3">
                <ChevronRight size={16} className={`text-[#A0AEC0] transition-transform ${expanded ? "rotate-90" : ""}`} />
                <div className="w-10 h-10 bg-[#EDF2F7] rounded-lg flex items-center justify-center shrink-0">
                  <Building2 size={18} className="text-[#A0AEC0]" />
                </div>
                <div>
                  <div className="font-extrabold text-[#1A202C] flex items-center gap-2">
                    {client.name}
                    {!client.active && <span className="text-[10px] font-bold bg-[#EDF2F7] text-[#718096] px-1.5 py-0.5 rounded border border-[#CBD5E0]">비활성</span>}
                  </div>
                  {client.memo && <div className="text-[12px] text-[#A0AEC0] mt-0.5 line-clamp-1">{client.memo}</div>}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="inline-flex w-fit items-center text-[12px] font-bold px-2 py-0.5 rounded-md bg-[#EDF2F7] text-[#4A5568]">{CLIENT_TYPE_LABEL[client.client_type]}</span>
                {client.uses_slots && <span className="inline-flex w-fit items-center gap-1 text-[11px] font-bold text-[#B7791F]"><Clock4 size={11} /> 확정슬롯</span>}
              </div>
              <div className="text-[14px] font-bold text-[#1A202C]">{client.branches_count}개</div>
              <div className="text-[14px] font-bold text-[#3182CE]">{client.active_jobs}건</div>
              <div className="text-[13px] text-[#4A5568]">
                {client.contact_name || "-"}
                {client.contact_phone && <div className="text-[11px] text-[#A0AEC0]">{client.contact_phone}</div>}
              </div>
              <div className="flex justify-end">
                <button onClick={(e) => { e.stopPropagation(); openEdit(client); }} title="편집" className="p-2 text-[#718096] hover:bg-[#E2E8F0] hover:text-[#1A202C] rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
                  <Pencil size={16} />
                </button>
              </div>
              </div>

              {/* 소속 지점 목록 */}
              {expanded && (
                <div className="px-6 pb-5 pt-1 bg-[#FBFCFE]">
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="text-[12px] font-bold text-[#718096]">소속 지점 {myBranches.length}개</span>
                    <button onClick={() => addBranchForClient(client.id)} className="flex items-center gap-1.5 text-[12px] font-bold text-[#3182CE] hover:bg-[#EBF8FF] px-3 py-1.5 rounded-lg transition-colors">
                      <Plus size={14} /> 이 화주사에 지점 추가
                    </button>
                  </div>
                  {myBranches.length === 0 ? (
                    <div className="text-[12.5px] text-[#A0AEC0] bg-white border border-dashed border-[#E2E8F0] rounded-xl py-4 text-center">아직 등록된 지점이 없어요.</div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {myBranches.map((b) => (
                        <span key={b.id} className={`inline-flex items-center gap-1.5 text-[12.5px] font-bold px-3 py-1.5 rounded-lg border ${b.active ? "bg-white border-[#E2E8F0] text-[#4A5568]" : "bg-[#F7FAFC] border-dashed border-[#E2E8F0] text-[#A0AEC0]"}`}>
                          <MapPin size={12} className="text-[#A0AEC0]" /> {b.name}
                          {!b.active && <span className="text-[10px] text-[#A0AEC0]">(비활성)</span>}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>
      </div>

      {/* 생성 / 편집 모달 */}
      {form && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => !saving && setForm(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#E2E8F0] sticky top-0 bg-white">
              <h2 className="text-[18px] font-extrabold text-[#1A202C]">{form.id === null ? "신규 화주사 등록" : "화주사 편집"}</h2>
              <button onClick={() => setForm(null)} className="text-[#A0AEC0] hover:text-[#4A5568] p-1 rounded-lg"><X size={20} /></button>
            </div>
            <div className="p-6 grid grid-cols-2 gap-5">
              <div className="col-span-2">
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">화주사 이름 <span className="text-[#E53E3E]">*</span></label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="예: 우아한형제들 (비마트)" className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
              </div>
              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">유형</label>
                <select value={form.client_type} onChange={(e) => setForm({ ...form, client_type: e.target.value as ClientType })} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]">
                  {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{CLIENT_TYPE_LABEL[t]}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-between p-3 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl">
                <div>
                  <div className="text-[13px] font-bold text-[#1A202C]">확정슬롯 사용</div>
                  <div className="text-[11px] text-[#718096] mt-0.5">지점×타임×요일 구인</div>
                </div>
                <button
                  onClick={() => setForm({ ...form, uses_slots: !form.uses_slots })}
                  className={`w-12 h-7 rounded-full relative transition-colors shrink-0 ${form.uses_slots ? "bg-[#38A169]" : "bg-[#CBD5E0]"}`}
                >
                  <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform ${form.uses_slots ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>
              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">담당자</label>
                <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} placeholder="김배달 팀장" className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
              </div>
              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">담당자 연락처</label>
                <input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} placeholder="01012345678" className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
              </div>
              <div className="col-span-2">
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">메모</label>
                <textarea value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} rows={2} placeholder="계약 조건, 특이사항 등" className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none" />
              </div>
              <div className="col-span-2 flex items-center justify-between p-4 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl">
                <div className="text-[14px] font-bold text-[#1A202C]">활성 상태</div>
                <button
                  onClick={() => setForm({ ...form, active: !form.active })}
                  className={`w-12 h-7 rounded-full relative transition-colors shrink-0 ${form.active ? "bg-[#38A169]" : "bg-[#CBD5E0]"}`}
                >
                  <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform ${form.active ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>
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
