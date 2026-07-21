import { useState, useCallback, useMemo } from "react";
import useSWR from "swr";
import { Shield, UserPlus, Phone, Pencil, Trash2, X, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";

interface SiteManager {
  id: number;
  name: string;
  phone: string | null;
  branch: string | null;
  role: string | null;
  note: string | null;
  active: boolean;
}

interface TeamForm {
  id: number | null;
  name: string;
  phone: string;
  branch: string;
  role: string;
  note: string;
  active: boolean;
}

const ROLES = ["현장", "지점 관리자", "본사", "마스터"];

function emptyForm(): TeamForm {
  return { id: null, name: "", phone: "", branch: "", role: "현장", note: "", active: true };
}

export function Team({ embedded = false }: { embedded?: boolean } = {}) {
  const confirm = useConfirm();
  // 담당자 목록은 SWR로 — 변경 후 갱신은 loadMembers(=mutate). 지점 목록은 읽기 전용 derive.
  const { data: membersApi, isLoading, mutate: mutateMembers } = useSWR<{ data?: SiteManager[] }>("/api/admin/site-managers");
  const members = useMemo(() => membersApi?.data ?? [], [membersApi]);
  const loading = isLoading && members.length === 0;
  const loadMembers = useCallback(async () => { await mutateMembers(); }, [mutateMembers]);

  const { data: branchesApi } = useSWR<{ data?: { name: string }[] }>("/api/admin/branches");
  const branches = useMemo(() => (branchesApi?.data ?? []).map((b) => b.name), [branchesApi]);

  const [form, setForm] = useState<TeamForm | null>(null);
  const [saving, setSaving] = useState(false);

  const openCreate = () => setForm(emptyForm());
  const openEdit = (m: SiteManager) =>
    setForm({
      id: m.id,
      name: m.name,
      phone: m.phone ?? "",
      branch: m.branch ?? "",
      role: m.role ?? "현장",
      note: m.note ?? "",
      active: m.active,
    });

  const handleSave = async () => {
    if (!form) return;
    const name = form.name.trim();
    const phone = form.phone.trim();
    if (!name) return toast.error("이름을 입력해주세요.");
    if (!phone) return toast.error("전화번호를 입력해주세요.");
    setSaving(true);
    try {
      const isEdit = form.id !== null;
      const payload = {
        name,
        phone,
        branch: form.branch.trim() || null,
        role: form.role.trim() || "현장",
        note: form.note.trim() || null,
        active: form.active,
      };
      const res = await fetch(
        isEdit ? `/api/admin/site-managers/${form.id}` : "/api/admin/site-managers",
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
      toast.success(isEdit ? "담당자 정보를 수정했어요." : "새 담당자를 등록했어요.");
      setForm(null);
      await loadMembers();
    } catch {
      toast.error("저장에 실패했어요");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!form || form.id === null) return;
    if (!(await confirm({ title: "담당자를 삭제할까요?", description: `'${form.name}' 담당자를 삭제합니다.`, confirmText: "삭제", destructive: true }))) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/site-managers/${form.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "삭제에 실패했어요");
        return;
      }
      toast.success("담당자를 삭제했어요.");
      setForm(null);
      await loadMembers();
    } catch {
      toast.error("삭제에 실패했어요");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={embedded ? "flex flex-col" : "p-8 pb-12 flex flex-col h-full overflow-y-auto"}>
      <div className="flex items-center justify-between mb-6">
        <div>
          {!embedded && <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">팀 · 권한</h1>}
          <p className="text-[14px] text-[#718096]">현장 담당자와 지점 관리자 연락처·권한을 관리합니다. 만남장소 안내·확정 알림에 사용됩니다.</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-[#FFCB3C] hover:bg-[#E0B500] text-[#1A202C] px-5 py-2.5 rounded-xl font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1A202C]"
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
        {!loading && members.length === 0 && (
          <div className="px-6 py-10 text-center text-[13px] text-[#A0AEC0]">
            등록된 담당자가 없어요. <button onClick={openCreate} className="text-[#3182CE] font-bold hover:underline">담당자 추가</button>를 눌러 시작하세요.
          </div>
        )}

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
                <button onClick={() => openEdit(member)} title="편집" className="p-2 text-[#718096] hover:bg-[#E2E8F0] hover:text-[#1A202C] rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
                  <Pencil size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 생성 / 편집 모달 */}
      {form && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => !saving && setForm(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#E2E8F0] sticky top-0 bg-white">
              <h2 className="text-[18px] font-extrabold text-[#1A202C]">{form.id === null ? "담당자 추가" : "담당자 편집"}</h2>
              <button onClick={() => setForm(null)} className="text-[#A0AEC0] hover:text-[#4A5568] p-1 rounded-lg"><X size={20} /></button>
            </div>
            <div className="p-6 grid grid-cols-2 gap-5">
              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">이름 <span className="text-[#E53E3E]">*</span></label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="홍길동" className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
              </div>
              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">전화번호 <span className="text-[#E53E3E]">*</span></label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="01012345678" className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
              </div>
              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">권한</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]">
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">담당 지점</label>
                <select value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]">
                  <option value="">전체 / 미지정</option>
                  {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">메모</label>
                <textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} rows={2} placeholder="만남장소, 특이사항 등" className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none" />
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
