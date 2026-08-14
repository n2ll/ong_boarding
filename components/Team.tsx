import { useState, useCallback, useMemo } from "react";
import useSWR from "swr";
import { Shield, UserPlus, Phone, Pencil, Trash2, X, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";
import { Modal } from "./ui/modal";
import { Button } from "./ui/button";
import { TextField, TextareaField, SelectField, ToggleRow } from "./ui/field";

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
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          {!embedded && <h1 className="text-2xl font-extrabold text-foreground tracking-tight mb-1">팀 · 권한</h1>}
          <p className="text-[14px] text-muted-foreground">현장 담당자와 지점 관리자 연락처·권한을 관리합니다. 만남장소 안내·확정 알림에 사용됩니다.</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-brand-yellow hover:bg-yellow-500 text-foreground px-5 py-2.5 rounded-xl font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
        >
          <UserPlus size={18} /> 담당자 추가
        </button>
      </div>

      <div className="bg-white border border-border-strong rounded-2xl shadow-sm overflow-x-auto flex flex-col">
        <div className="grid min-w-[760px] grid-cols-[2fr_1.5fr_1.5fr_1fr_0.5fr] items-center px-6 py-3.5 border-b border-border-strong bg-background text-[13px] font-bold text-muted-foreground">
          <div>이름 / 연락처</div>
          <div>권한 (Role)</div>
          <div>담당 지점</div>
          <div>상태</div>
          <div className="text-right">관리</div>
        </div>

        {loading && <div className="px-6 py-8 text-[13px] text-muted-foreground">담당자 목록 불러오는 중…</div>}
        {!loading && members.length === 0 && (
          <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
            등록된 담당자가 없어요. <button onClick={openCreate} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-info font-bold hover:underline">담당자 추가</button>를 눌러 시작하세요.
          </div>
        )}

        <div className="flex flex-col">
          {members.map((member) => (
            <div key={member.id} className="grid min-w-[760px] grid-cols-[2fr_1.5fr_1.5fr_1fr_0.5fr] items-center px-6 py-5 border-b border-muted hover:bg-background transition-colors">
              <div className="flex flex-col">
                <div className="font-extrabold text-foreground">{member.name}</div>
                <div className="text-[12px] text-muted-foreground flex items-center gap-1 mt-0.5"><Phone size={10} /> {member.phone || "연락처 없음"}</div>
              </div>

              <div>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-bold ${member.role === '마스터' || member.role === '본사' ? 'bg-info-soft text-info-strong' : 'bg-muted text-gray-700'}`}>
                  <Shield size={12} /> {member.role || "현장"}
                </span>
              </div>

              <div className="text-[13px] font-bold text-gray-700">{member.branch || "전체"}</div>

              <div>
                <span className={`inline-flex px-2.5 py-1 rounded-full text-[12px] font-bold ${member.active ? 'bg-success-soft text-success-strong' : 'bg-error-soft text-error-strong'}`}>
                  {member.active ? '활성' : '비활성'}
                </span>
              </div>

              <div className="flex justify-end">
                <button onClick={() => openEdit(member)} title="편집" className="after:absolute after:-inset-2 after:content-[''] relative p-2 text-muted-foreground hover:bg-gray-200 hover:text-foreground rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow">
                  <Pencil size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 생성 / 편집 모달 */}
      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        busy={saving}
        size="lg"
        title={form?.id === null ? "담당자 추가" : "담당자 편집"}
        description="이름과 전화번호만 있으면 저장됩니다."
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
          <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
            <TextField
              required
              label="이름"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="홍길동"
            />
            <TextField
              required
              label="전화번호"
              inputMode="numeric"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="01012345678"
            />
            <SelectField
              label="권한"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </SelectField>
            <SelectField
              label="담당 지점"
              value={form.branch}
              onChange={(e) => setForm({ ...form, branch: e.target.value })}
            >
              <option value="">전체 / 미지정</option>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </SelectField>
            <TextareaField
              full
              label="메모"
              rows={2}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="만남장소, 특이사항 등"
            />
            <ToggleRow
              full
              label="활성 상태"
              description="끄면 공고의 현장 매니저 목록에서 숨겨집니다"
              checked={form.active}
              onChange={(v) => setForm({ ...form, active: v })}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
