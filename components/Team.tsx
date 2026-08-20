import { useState, useCallback, useMemo } from "react";
import useSWR from "swr";
import { BriefcaseBusiness, UserPlus, Phone, Pencil, Trash2, Save, AlertCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";
import { Modal } from "./ui/modal";
import { Button } from "./ui/button";
import { TextField, TextareaField, SelectField, ToggleRow } from "./ui/field";
import { teamDirectoryView } from "@/lib/admin/team-directory";

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
const ROLE_LABEL: Record<string, string> = {
  현장: "현장 담당",
  "지점 관리자": "지점 담당",
  본사: "본사 운영",
  마스터: "본사 총괄",
};

function emptyForm(): TeamForm {
  return { id: null, name: "", phone: "", branch: "", role: "현장", note: "", active: true };
}

export function Team({ embedded = false }: { embedded?: boolean } = {}) {
  const confirm = useConfirm();
  // 담당자 목록은 SWR로 — 변경 후 갱신은 loadMembers(=mutate). 지점 목록은 읽기 전용 derive.
  const { data: membersApi, error: membersError, isValidating: membersValidating, mutate: mutateMembers } = useSWR<{ data?: SiteManager[] }>("/api/admin/site-managers");
  const members = useMemo(() => membersApi?.data ?? [], [membersApi]);
  const loadMembers = useCallback(async () => { await mutateMembers(); }, [mutateMembers]);

  const { data: branchesApi, error: branchesError, isValidating: branchesValidating, mutate: mutateBranches } = useSWR<{ data?: { name: string }[] }>("/api/admin/branches");
  const branches = useMemo(() => (branchesApi?.data ?? []).map((b) => b.name), [branchesApi]);
  const directoryView = teamDirectoryView({
    members: membersApi ? membersApi.data ?? [] : undefined,
    branches: branchesApi ? branchesApi.data ?? [] : undefined,
    memberError: membersError,
    branchError: branchesError,
  });
  const refreshing = membersValidating || branchesValidating;
  const reloadAll = useCallback(() => {
    void Promise.all([mutateMembers(), mutateBranches()]);
  }, [mutateBranches, mutateMembers]);

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
    <div className={embedded ? "flex flex-col" : "p-4 pb-12 sm:p-6 lg:p-8 flex flex-col [&>*]:shrink-0"}>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          {!embedded && <h1 className="text-2xl font-extrabold text-foreground tracking-tight mb-1">현장 담당자</h1>}
          <p className="text-[14px] text-muted-foreground">연락처와 담당 지점을 관리합니다. 이 화면의 업무 역할은 로그인 권한을 변경하지 않습니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={reloadAll} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} /> 새로고침
          </Button>
          <Button variant="brand" onClick={openCreate} disabled={directoryView.state !== "ready"}>
          <UserPlus size={18} /> 담당자 추가
          </Button>
        </div>
      </div>

      {directoryView.state === "loading" && <div aria-label="담당자 목록 불러오는 중" className="h-44 animate-pulse rounded-2xl border border-border bg-muted/60" />}

      {directoryView.state === "error" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-error/30 bg-error-soft p-4 text-error-strong">
          <div className="flex items-start gap-2 text-[13px] font-bold"><AlertCircle size={17} className="mt-0.5 shrink-0" /> 담당자 현황을 불러오지 못했어요. 실패한 데이터: {directoryView.sources.join(", ")}</div>
          <Button variant="secondary" size="sm" onClick={reloadAll} isLoading={refreshing}>다시 불러오기</Button>
        </div>
      )}

      {directoryView.state === "ready" && members.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border-strong bg-card px-6 py-12 text-center text-[14px] text-muted-foreground">
          <p>등록된 현장 담당자가 없어요.</p>
          <Button variant="brand" size="sm" onClick={openCreate} className="mt-4"><UserPlus size={15} /> 첫 담당자 추가</Button>
        </div>
      )}

      {directoryView.state === "ready" && members.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-border-strong bg-card shadow-sm">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead className="bg-background text-[12px] font-bold text-muted-foreground">
              <tr>
                <th scope="col" className="px-5 py-3.5">이름·연락처</th>
                <th scope="col" className="px-4 py-3.5">업무 역할</th>
                <th scope="col" className="px-4 py-3.5">담당 지점</th>
                <th scope="col" className="px-4 py-3.5">상태</th>
                <th scope="col" className="px-4 py-3.5 text-right">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-muted">
              {members.map((member) => (
                <tr key={member.id} className="transition-colors hover:bg-background">
                  <th scope="row" className="px-5 py-4 font-normal">
                    <div className="font-extrabold text-foreground">{member.name}</div>
                    <div className="mt-0.5 flex items-center gap-1 text-[12px] text-muted-foreground"><Phone size={11} /> {member.phone || "연락처 없음"}</div>
                  </th>
                  <td className="px-4 py-4">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[12px] font-bold text-gray-700">
                      <BriefcaseBusiness size={12} /> {ROLE_LABEL[member.role ?? "현장"] ?? member.role ?? "현장 담당"}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-[13px] font-bold text-gray-700">{member.branch || "전체 / 미지정"}</td>
                  <td className="px-4 py-4">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-[12px] font-bold ${member.active ? 'bg-success-soft text-success-strong' : 'bg-muted text-muted-foreground'}`}>
                      {member.active ? '활성' : '비활성'}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(member)} aria-label={`${member.name} 담당자 편집`}><Pencil size={16} /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 생성 / 편집 모달 */}
      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        busy={saving}
        size="lg"
        title={form?.id === null ? "담당자 추가" : "담당자 편집"}
        description="지원자 안내에 필요한 연락처와 담당 범위를 기록합니다. 로그인 권한과는 무관합니다."
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
              label="업무 역할"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              hint="표시·분류용 역할이며 시스템 접근 권한을 바꾸지 않습니다."
            >
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>)}
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
