"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  AlertTriangle,
  Building2,
  ChevronDown,
  Clock4,
  Database,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";
import { Modal } from "./ui/modal";
import { Button } from "./ui/button";
import { controlBase, SelectField, TextareaField, TextField, ToggleRow } from "./ui/field";
import { CLIENT_TYPE_LABEL, type ClientType } from "@/lib/admin/types";
import { jsonFetcher } from "@/lib/swr";
import { clientRegistryOverview, integrityOverview } from "@/lib/admin/shipper-operations";

interface BranchLite {
  id: number;
  name: string;
  active: boolean;
  client_id: number | null;
}

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
  jobs_client_backfillable: number;
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

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 border-l border-border-strong pl-4 first:border-l-0 first:pl-0">
      <div className="tabular-nums text-[20px] font-extrabold leading-none text-foreground">{value}</div>
      <div className="mt-1 text-xs font-bold text-muted-foreground">{label}</div>
    </div>
  );
}

export function Clients() {
  const router = useRouter();
  const confirm = useConfirm();
  const {
    data: clientsApi,
    error: clientsError,
    mutate: mutateClients,
  } = useSWR<{ data?: ApiClient[] }>("/api/admin/clients", jsonFetcher);
  const {
    data: branchesApi,
    error: branchesError,
    mutate: mutateBranches,
  } = useSWR<{ data?: BranchLite[] }>("/api/admin/branches", jsonFetcher);
  const {
    data: integrityApi,
    error: integrityError,
    mutate: mutateIntegrity,
  } = useSWR<{ report?: IntegrityReport }>("/api/admin/data-integrity", jsonFetcher);

  const clientsSource = clientsApi === undefined ? undefined : clientsApi.data ?? [];
  const branchesSource = branchesApi === undefined ? undefined : branchesApi.data ?? [];
  const integrityReport = integrityApi === undefined ? undefined : integrityApi.report ?? null;
  const registry = clientRegistryOverview({ clients: clientsSource, error: clientsError });
  const integrity = integrityOverview({ report: integrityReport, error: integrityError });
  const clients = clientsSource ?? [];
  const branches = branchesSource ?? [];

  const [search, setSearch] = useState("");
  const [form, setForm] = useState<ClientForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [integrityRunning, setIntegrityRunning] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const branchesByClient = useMemo(() => {
    const result = new Map<number, BranchLite[]>();
    for (const branch of branches) {
      if (branch.client_id === null) continue;
      const current = result.get(branch.client_id) ?? [];
      current.push(branch);
      result.set(branch.client_id, current);
    }
    return result;
  }, [branches]);

  const normalizedSearch = search.trim().toLocaleLowerCase("ko-KR");
  const filtered = useMemo(
    () => clients.filter((client) => {
      if (!normalizedSearch) return true;
      return client.name.toLocaleLowerCase("ko-KR").includes(normalizedSearch)
        || (client.contact_name ?? "").toLocaleLowerCase("ko-KR").includes(normalizedSearch);
    }),
    [clients, normalizedSearch],
  );

  const openCreate = () => {
    setFormError(null);
    setForm(emptyForm());
  };

  const openEdit = (client: ApiClient) => {
    setFormError(null);
    setForm({
      id: client.id,
      name: client.name,
      client_type: client.client_type,
      uses_slots: client.uses_slots,
      contact_name: client.contact_name ?? "",
      contact_phone: client.contact_phone ?? "",
      memo: client.memo ?? "",
      active: client.active,
    });
  };

  const runSync = async () => {
    if (syncing) return;
    const approved = await confirm({
      title: "옹매니징 원본을 가져올까요?",
      description: "원본 화주사를 운영 목록에 새로 만들거나 연결하고, 이미 연결된 화주사 이름은 원본 기준으로 갱신합니다. 유형·슬롯 설정은 유지됩니다.",
      confirmText: "가져오기",
    });
    if (!approved) return;

    setSyncing(true);
    try {
      const response = await fetch("/api/admin/clients/sync-ongmanaging", { method: "POST" });
      const json = await response.json();
      if (json.configured === false) {
        toast.error(json.error || "옹매니징 연동이 설정되지 않았어요.");
        return;
      }
      if (!response.ok) {
        toast.error(json.error || "원본 가져오기에 실패했어요.");
        return;
      }

      const changed = (json.created ?? 0) + (json.renamed ?? 0) + (json.linked ?? 0);
      const failed = json.errors?.length ?? 0;
      if (failed > 0) {
        console.error("[sync-ongmanaging]", json.errors);
        toast.warning(`원본 ${json.total}곳 중 ${failed}곳을 가져오지 못했어요. 신규 ${json.created} · 연결 ${json.linked} · 이름 갱신 ${json.renamed}`);
      } else {
        toast.success(changed > 0
          ? `신규 ${json.created} · 연결 ${json.linked} · 이름 갱신 ${json.renamed}`
          : "운영 목록이 이미 원본과 일치해요.");
      }
      await mutateClients();
    } catch {
      toast.error("원본 가져오기에 실패했어요. 잠시 후 다시 시도해주세요.");
    } finally {
      setSyncing(false);
    }
  };

  const runBackfill = async () => {
    if (
      integrityRunning
      || integrity.state !== "ready"
      || registry.state !== "ready"
      || integrity.autoFixable === 0
    ) return;
    const approved = await confirm({
      title: `${integrity.autoFixable}건을 자동 연결할까요?`,
      description: "중복 없이 지점 이름이 일치하는 공고와, 이미 지점의 화주사가 명확한 공고만 연결합니다. 화주사를 알 수 없는 지점은 수동 확인으로 남기며, 기존 연결은 바꾸지 않습니다.",
      confirmText: "자동 연결",
    });
    if (!approved) return;

    setIntegrityRunning(true);
    try {
      const response = await fetch("/api/admin/data-integrity", { method: "POST" });
      const json = await response.json();
      if (!response.ok) {
        toast.error(json.error || "자동 연결에 실패했어요.");
        return;
      }
      await mutateIntegrity({ report: json.report as IntegrityReport }, { revalidate: false });
      await Promise.all([mutateClients(), mutateBranches()]);
      const fixed = json.fixed ?? {};
      const total = (fixed.jobs_branch ?? 0) + (fixed.jobs_client ?? 0) + (fixed.branches_client ?? 0);
      toast.success(total > 0 ? `${total}건의 연결을 채웠어요.` : "새로 연결할 항목이 없어요.");
    } catch {
      toast.error("자동 연결에 실패했어요. 잠시 후 다시 시도해주세요.");
    } finally {
      setIntegrityRunning(false);
    }
  };

  const handleSave = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      setFormError("화주사 이름을 입력해주세요.");
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      const isEdit = form.id !== null;
      const response = await fetch(isEdit ? `/api/admin/clients/${form.id}` : "/api/admin/clients", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          client_type: form.client_type,
          uses_slots: form.uses_slots,
          contact_name: form.contact_name.trim() || null,
          contact_phone: form.contact_phone.trim() || null,
          memo: form.memo.trim() || null,
          active: form.active,
        }),
      });
      const json = await response.json();
      if (!response.ok) {
        setFormError(json.error || "저장에 실패했어요.");
        return;
      }
      toast.success(isEdit ? "화주사 정보를 수정했어요." : "새 화주사를 등록했어요.");
      setForm(null);
      await mutateClients();
    } catch {
      setFormError("저장에 실패했어요. 잠시 후 다시 시도해주세요.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!form || form.id === null) return;
    const approved = await confirm({
      title: "화주사를 삭제할까요?",
      description: `'${form.name}' 화주사를 삭제합니다. 소속 지점이 있으면 비활성 처리됩니다.`,
      confirmText: "삭제",
      destructive: true,
    });
    if (!approved) return;

    setSaving(true);
    setFormError(null);
    try {
      const response = await fetch(`/api/admin/clients/${form.id}`, { method: "DELETE" });
      const json = await response.json();
      if (!response.ok) {
        setFormError(json.error || "삭제에 실패했어요.");
        return;
      }
      toast.success(json.soft ? json.message || "비활성화했어요." : "삭제했어요.");
      setForm(null);
      await mutateClients();
    } catch {
      setFormError("삭제에 실패했어요. 잠시 후 다시 시도해주세요.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="operational-clients-heading" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
            <Database aria-hidden="true" size={14} /> 운영 기준
          </div>
          <h2 id="operational-clients-heading" className="text-[18px] font-extrabold text-foreground">
            공고 운영 화주사
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            공고·지점에 실제로 연결되는 목록입니다. 신규 등록과 담당자·슬롯 설정은 여기서 관리합니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={runSync}
            isLoading={syncing}
            disabled={registry.state === "loading" || registry.state === "error"}
          >
            {!syncing && <RefreshCw aria-hidden="true" />} {syncing ? "원본 가져오는 중" : "원본에서 가져오기"}
          </Button>
          <Button
            variant="primary"
            onClick={openCreate}
            disabled={registry.state === "loading" || registry.state === "error"}
          >
            <Plus aria-hidden="true" /> 신규 화주사
          </Button>
        </div>
      </div>

      {registry.state === "ready" && (
        <div className="grid grid-cols-2 gap-4 rounded-2xl border border-border-strong bg-card px-5 py-4 shadow-xs sm:grid-cols-4">
          <Metric label={`운영 중 · 전체 ${registry.total}곳`} value={registry.active} />
          <Metric label="연결 지점" value={registry.branches} />
          <Metric label="진행 공고" value={registry.activeJobs} />
          <Metric label="비활성" value={registry.total - registry.active} />
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border-strong bg-card shadow-sm">
        {registry.state === "loading" && (
          <div className="space-y-3 p-5" aria-label="화주사 목록 불러오는 중">
            {[0, 1, 2].map((item) => <div key={item} className="h-16 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />)}
          </div>
        )}

        {registry.state === "error" && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-4 bg-error-soft p-5">
            <div className="flex min-w-0 items-start gap-3">
              <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0 text-error-strong" size={18} />
              <div>
                <div className="text-[14px] font-extrabold text-error-strong">운영 화주사를 불러오지 못했어요</div>
                <p className="mt-0.5 text-[12px] text-error-strong">목록과 집계 숫자를 표시하지 않았습니다. 연결 상태를 확인한 뒤 다시 시도해주세요.</p>
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void mutateClients()}>다시 시도</Button>
          </div>
        )}

        {registry.state === "empty" && (
          <div className="flex flex-col items-center px-5 py-12 text-center">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Building2 aria-hidden="true" size={20} />
            </div>
            <div className="mt-3 text-[14px] font-extrabold text-foreground">등록된 운영 화주사가 없어요</div>
            <p className="mt-1 text-[12px] text-muted-foreground">직접 등록하거나 옹매니징 원본에서 가져올 수 있습니다.</p>
            <Button className="mt-4" size="sm" onClick={openCreate}><Plus aria-hidden="true" /> 신규 화주사</Button>
          </div>
        )}

        {registry.state === "ready" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-strong p-4">
              <label className="relative block w-full sm:w-[280px]">
                <span className="sr-only">기업명 또는 담당자 검색</span>
                <Search aria-hidden="true" size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="기업명·담당자 검색" className={`${controlBase} min-h-11 py-2.5 pl-10`} />
              </label>
              <span className="text-[12px] font-bold text-muted-foreground">{filtered.length}곳 표시</span>
            </div>

            <div className="hidden grid-cols-[minmax(0,2fr)_minmax(100px,1fr)_76px_76px_minmax(110px,1fr)_44px] items-center gap-3 border-b border-border-strong bg-background px-4 py-3 text-xs font-extrabold text-muted-foreground xl:grid">
              <span>화주사</span><span>유형</span><span>지점</span><span>공고</span><span>담당자</span><span className="sr-only">관리</span>
            </div>

            {filtered.length === 0 ? (
              <div className="px-5 py-10 text-center text-[13px] text-muted-foreground">‘{search.trim()}’에 맞는 화주사가 없어요.</div>
            ) : (
              <div>
                {filtered.map((client) => {
                  const expanded = expandedId === client.id;
                  const clientBranches = branchesByClient.get(client.id) ?? [];
                  const detailsId = `client-${client.id}-branches`;
                  return (
                    <article key={client.id} className={`grid grid-cols-[minmax(0,1fr)_44px] border-b border-border last:border-b-0 xl:grid-cols-[minmax(0,2fr)_minmax(100px,1fr)_76px_76px_minmax(110px,1fr)_44px] ${client.active ? "" : "bg-muted/35"}`}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={detailsId}
                        onClick={() => setExpandedId(expanded ? null : client.id)}
                        className="min-w-0 px-4 py-4 text-left outline-none transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring xl:col-span-5 xl:grid xl:grid-cols-[minmax(0,2fr)_minmax(100px,1fr)_76px_76px_minmax(110px,1fr)] xl:items-center xl:gap-3"
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <ChevronDown aria-hidden="true" size={16} className={`shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${expanded ? "" : "-rotate-90"}`} />
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Building2 aria-hidden="true" size={16} /></span>
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-2 font-extrabold text-foreground">
                              <span className="break-words">{client.name}</span>
                              {!client.active && <span className="rounded-full border border-border-strong bg-muted px-2 py-0.5 text-xs font-bold text-muted-foreground">비활성</span>}
                            </span>
                            {client.memo && <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={client.memo}>{client.memo}</span>}
                          </span>
                        </span>

                        <span className="mt-3 grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4 xl:hidden">
                          <span><span className="block text-xs font-bold text-muted-foreground">유형</span><span className="mt-0.5 block font-bold text-foreground">{CLIENT_TYPE_LABEL[client.client_type]}</span></span>
                          <span><span className="block text-xs font-bold text-muted-foreground">지점</span><span className="mt-0.5 block font-bold text-foreground">{client.branches_count}곳</span></span>
                          <span><span className="block text-xs font-bold text-muted-foreground">진행 공고</span><span className="mt-0.5 block font-bold text-foreground">{client.active_jobs}건</span></span>
                          <span><span className="block text-xs font-bold text-muted-foreground">담당자</span><span className="mt-0.5 block truncate font-bold text-foreground">{client.contact_name || "미등록"}</span></span>
                        </span>

                        <span className="hidden min-w-0 xl:block">
                          <span className="inline-flex rounded-full bg-muted px-2 py-1 text-xs font-bold text-foreground">{CLIENT_TYPE_LABEL[client.client_type]}</span>
                          {client.uses_slots && <span className="mt-1 flex items-center gap-1 text-xs font-bold text-warning-strong"><Clock4 aria-hidden="true" size={11} /> 확정슬롯</span>}
                        </span>
                        <span className="hidden tabular-nums text-[13px] font-extrabold text-foreground xl:block">{client.branches_count}</span>
                        <span className="hidden tabular-nums text-[13px] font-extrabold text-foreground xl:block">{client.active_jobs}</span>
                        <span className="hidden min-w-0 text-[12px] text-foreground xl:block">
                          <span className="block truncate font-bold">{client.contact_name || "미등록"}</span>
                          {client.contact_phone && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{client.contact_phone}</span>}
                        </span>
                      </button>
                      <Button variant="ghost" size="icon" aria-label={`${client.name} 편집`} onClick={() => openEdit(client)} className="m-auto rounded-xl"><Pencil aria-hidden="true" /></Button>

                      {expanded && (
                        <div id={detailsId} className="col-span-2 border-t border-border bg-background/55 px-4 py-4 xl:col-span-6 xl:pl-16">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="text-[12px] font-extrabold text-foreground">연결 지점</div>
                            <Button variant="ghost" size="toolbar" onClick={() => router.push(`/branches?client=${client.id}`)}><Plus aria-hidden="true" /> 지점 추가</Button>
                          </div>
                          {branchesError ? (
                            <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-error/25 bg-error-soft px-3 py-2 text-[12px] font-bold text-error-strong">
                              지점 목록을 불러오지 못했어요.
                              <Button variant="ghost" size="toolbar" onClick={() => void mutateBranches()}>다시 시도</Button>
                            </div>
                          ) : branchesSource === undefined ? (
                            <div className="mt-3 h-10 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" aria-label="지점 불러오는 중" />
                          ) : clientBranches.length === 0 ? (
                            <p className="mt-3 text-[12px] text-muted-foreground">연결된 지점이 없습니다.</p>
                          ) : (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {clientBranches.map((branch) => (
                                <span key={branch.id} className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] font-bold ${branch.active ? "border-border-strong bg-card text-foreground" : "border-dashed border-border-strong bg-muted text-muted-foreground"}`}>
                                  <MapPin aria-hidden="true" size={12} /> {branch.name}{!branch.active && " · 비활성"}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div className="rounded-2xl border border-border-strong bg-card p-4 shadow-xs">
        {integrity.state === "loading" && (
          <div className="flex items-center gap-3 text-[13px] font-bold text-muted-foreground" aria-label="데이터 연결 상태 불러오는 중">
            <span className="size-5 animate-pulse rounded-md bg-muted motion-reduce:animate-none" /> 데이터 연결 상태를 확인하고 있어요.
          </div>
        )}
        {integrity.state === "error" && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[13px] font-bold text-error-strong"><AlertTriangle aria-hidden="true" size={16} /> 데이터 연결 상태를 불러오지 못했어요.</div>
            <Button variant="secondary" size="sm" onClick={() => void mutateIntegrity()}>다시 시도</Button>
          </div>
        )}
        {integrity.state === "empty" && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[13px] font-bold text-muted-foreground">표시할 데이터 연결 점검 결과가 없어요.</div>
            <Button variant="secondary" size="sm" onClick={() => void mutateIntegrity()}>다시 확인</Button>
          </div>
        )}
        {integrity.state === "ready" && (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <div className={`flex items-center gap-2 text-[13px] font-extrabold ${integrity.issues > 0 ? "text-warning-strong" : "text-success-strong"}`}>
                {integrity.issues > 0 ? <AlertTriangle aria-hidden="true" size={16} /> : <Database aria-hidden="true" size={16} />}
                {integrity.issues > 0 ? `연결 확인이 필요한 항목 ${integrity.issues}건` : "공고·지점 연결 상태가 정상입니다"}
              </div>
              {integrityReport && (
                <details className="mt-1 text-xs text-muted-foreground">
                  <summary className="cursor-pointer font-bold outline-none focus-visible:ring-2 focus-visible:ring-ring">세부 내역 보기</summary>
                  <p className="mt-2 leading-relaxed">공고–지점 자동 연결 {integrityReport.jobs_backfillable} · 공고–화주사 자동 연결 {integrityReport.jobs_client_backfillable} · 자동 연결 불가 공고 {integrityReport.jobs_unmatched} · 화주사 누락 지점 {integrityReport.branches_missing_client}</p>
                </details>
              )}
            </div>
            {registry.state === "ready" && integrity.autoFixable > 0 && (
              <Button variant="secondary" size="sm" onClick={runBackfill} isLoading={integrityRunning}>
                {!integrityRunning && <Save aria-hidden="true" />} {integrityRunning ? "연결하는 중" : `${integrity.autoFixable}건 자동 연결`}
              </Button>
            )}
          </div>
        )}
      </div>

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        busy={saving}
        size="lg"
        title={form?.id === null ? "신규 화주사 등록" : "화주사 편집"}
        description="이름만 넣어도 저장됩니다. 운영에 필요한 정보부터 차례로 채워주세요."
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            {form?.id !== null && form ? (
              <Button variant="ghost" size="sm" onClick={handleDelete} disabled={saving} className="text-error-strong hover:bg-error-soft"><Trash2 aria-hidden="true" /> 삭제</Button>
            ) : <span />}
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setForm(null)} disabled={saving}>취소</Button>
              <Button size="sm" onClick={handleSave} isLoading={saving}><Save aria-hidden="true" /> 저장</Button>
            </div>
          </div>
        }
      >
        {form && (
          <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
            {formError && <div role="alert" className="col-span-full rounded-xl border border-error/25 bg-error-soft px-3 py-2 text-[12px] font-bold text-error-strong">{formError}</div>}
            <TextField full required label="화주사 이름" value={form.name} onChange={(event) => { setFormError(null); setForm({ ...form, name: event.target.value }); }} placeholder="예: OO도시락" />
            <SelectField label="유형" value={form.client_type} onChange={(event) => setForm({ ...form, client_type: event.target.value as ClientType })}>
              {TYPE_OPTIONS.map((type) => <option key={type} value={type}>{CLIENT_TYPE_LABEL[type]}</option>)}
            </SelectField>
            <ToggleRow label="확정슬롯 사용" description="지점×타임×요일 단위로 구인" checked={form.uses_slots} onChange={(value) => setForm({ ...form, uses_slots: value })} className="sm:mt-[1.6rem]" />
            <TextField label="담당자" value={form.contact_name} onChange={(event) => setForm({ ...form, contact_name: event.target.value })} placeholder="김배달 팀장" />
            <TextField label="담당자 연락처" type="tel" inputMode="tel" value={form.contact_phone} onChange={(event) => setForm({ ...form, contact_phone: event.target.value })} placeholder="01012345678" />
            <TextareaField full label="메모" rows={2} value={form.memo} onChange={(event) => setForm({ ...form, memo: event.target.value })} placeholder="계약 조건, 특이사항 등" />
            <ToggleRow full label="활성 상태" description="끄면 공고 등록 시 선택 목록에 표시되지 않습니다" checked={form.active} onChange={(value) => setForm({ ...form, active: value })} />
          </div>
        )}
      </Modal>
    </section>
  );
}
