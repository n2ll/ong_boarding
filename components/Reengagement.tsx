"use client";

import { useState } from "react";
import useSWR from "swr";
import { RefreshCw, Loader2, Users, UserPlus, ShieldAlert, Lock, AlertCircle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { jsonFetcher } from "@/lib/swr";
import { PageShell } from "@/components/ui/page-shell";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmDialog";

interface ActiveCandidate {
  key: string;
  name: string | null;
  phoneMasked: string;
  sources: string[];
}
interface Resp {
  configured: boolean;
  enabled: boolean;
  activeCount: number;
  inactiveCount: number;
  totalEligible: number;
  excludedBlacklist: number;
  excludedApplicants: number;
  activeCandidates: ActiveCandidate[];
  templates: { offer: string; optin: string };
}

const SRC_LABEL: Record<string, string> = { tms: "옹고잉 배차", ongmanaging: "옹매니징 계약" };

export function Reengagement() {
  const confirm = useConfirm();
  // 외부 DB(옹고잉 AWS RDS 등) 조회라 페이지 로드·포커스마다 자동 호출하지 않는다 — 매니저가 명시적으로 발굴.
  const [triggered, setTriggered] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<Resp>(
    triggered ? "/api/admin/reengagement" : null,
    jsonFetcher,
    { revalidateOnFocus: false, revalidateOnReconnect: false }
  );
  const [importing, setImporting] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [lastImport, setLastImport] = useState<{ requested: number; imported: number } | null>(null);

  const runImport = async () => {
    if (importing) return;
    const keysToImport = data?.activeCandidates
      .map((candidate) => candidate.key)
      .filter((key) => selectedKeys.has(key)) ?? [];
    if (keysToImport.length === 0) return toast.error("편입할 후보를 1명 이상 선택해주세요.");
    if (!(await confirm({
      title: `선택한 ${keysToImport.length}명을 인력풀에 편입할까요?`,
      description: "이름과 전화번호가 옹보딩 인력풀에 저장됩니다. 이 단계에서는 문자를 발송하지 않으며, 근무 배정이나 확정도 이루어지지 않습니다.",
      confirmText: `${keysToImport.length}명 편입`,
    }))) return;
    setImporting(true);
    try {
      const res = await fetch("/api/admin/reengagement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateKeys: keysToImport }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "편입에 실패했어요");
        return;
      }
      if (json.enabled === false) {
        toast.info(json.note || "‘다시 부르기’가 꺼져 있어요 — 편입 잠금(미리보기만)");
      } else {
        const result = { requested: Number(json.requested ?? keysToImport.length), imported: Number(json.imported ?? 0) };
        setLastImport(result);
        setSelectedKeys(new Set());
        toast.success(json.note || `${result.imported}명을 인력풀에 편입했어요.`);
        await mutate();
      }
    } catch {
      toast.error("편입에 실패했어요");
    } finally {
      setImporting(false);
    }
  };

  const candidateKeys = data?.activeCandidates.map((candidate) => candidate.key) ?? [];
  const selectedCount = candidateKeys.filter((key) => selectedKeys.has(key)).length;
  const allSelected = candidateKeys.length > 0 && candidateKeys.every((key) => selectedKeys.has(key));
  const toggleCandidate = (key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleAll = () => setSelectedKeys(allSelected ? new Set() : new Set(candidateKeys));

  return (
    <PageShell className="max-w-5xl w-full">
      <h1 className="sr-only">다시 부르기 (외부 인력)</h1>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-extrabold text-foreground">외부 인력 검토 후 편입</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground mt-1">
            옹고잉·옹매니징의 활동 이력이 있는 분을 확인하고, 필요한 분만 옹보딩 인력풀에 추가합니다.
          </p>
        </div>
        {triggered && (
          <Button variant="ghost" size="sm" onClick={() => void mutate()} disabled={isLoading}>
            <RefreshCw size={14} /> 다시 발굴
          </Button>
        )}
      </div>

      {!triggered && (
        <div className="rounded-2xl border border-border-strong bg-card p-6 text-center space-y-4 shadow-sm">
          <p className="text-[14px] text-gray-700 leading-relaxed">
            외부 시스템을 읽기 전용으로 조회합니다. 조회만으로 개인정보를 옹보딩에 저장하거나 문자를 보내지 않습니다.
          </p>
          <Button onClick={() => setTriggered(true)}>
            <RefreshCw size={15} /> 다시 부를 분 찾기
          </Button>
        </div>
      )}

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-error/30 bg-error-soft px-4 py-3 text-[13px] font-semibold text-error-strong">
          <span className="flex items-center gap-2"><AlertCircle size={16} /> 발굴에 실패했어요. 기존 후보 수를 0으로 표시하지 않았습니다.</span>
          <Button variant="secondary" size="sm" onClick={() => void mutate()}>다시 시도</Button>
        </div>
      )}
      {!error && data && !data.configured && (
        <div className="px-4 py-3 rounded-2xl bg-muted border border-border-strong text-[13px] font-semibold text-muted-foreground">
          옹고잉·옹매니징 미연동 — 다시 부를 분을 찾을 수 없어요.
        </div>
      )}
      {isLoading && (
        <div role="status" className="flex items-center gap-2 rounded-2xl border border-border bg-card px-4 py-8 text-[13px] font-bold text-muted-foreground">
          <Loader2 size={16} className="animate-spin" /> 후보를 발굴하는 중…
        </div>
      )}

      {lastImport && (
        <div role="status" className="flex items-start gap-2 rounded-2xl border border-success/25 bg-success-soft px-4 py-3 text-[13px] text-success-strong">
          <CheckCircle2 size={17} className="mt-0.5 shrink-0" />
          <span><b>편입 결과:</b> 선택 {lastImport.requested}명 중 {lastImport.imported}명을 인력풀에 추가했습니다. 문자 발송·근무 확정은 하지 않았습니다.</span>
        </div>
      )}

      {data?.configured && (
        <>
          {/* 킬스위치 상태 */}
          <div
            className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl text-[13px] font-bold border ${
              data.enabled
                ? "bg-success-soft border-success/25 text-success-strong"
                : "bg-yellow-50 border-yellow-300 text-warning-strong"
            }`}
          >
            <Lock size={14} />
            {/* 예전엔 "스위치를 켜세요"라고만 안내하고 콘솔에 그 스위치가 없어 DB를 고쳐야 했다 →
                설정 › 기능 스위치로 링크해 그 자리에서 켤 수 있게 한다. */}
            {data.enabled ? (
              <span>다시 부르기 켜짐 — 인력풀에 편입할 수 있어요</span>
            ) : (
              <span>
                다시 부르기 꺼짐 — 편입 잠금(미리보기만). 법적 검토·승인이 끝났으면{" "}
                <Link href="/settings?section=switches" className="underline font-extrabold hover:text-warning-strong rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-700/40">
                  설정 › 기능 스위치
                </Link>
                에서 켜 주세요.
              </span>
            )}
          </div>

          {/* 요약 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-2xl border border-success/25 bg-success-soft p-3">
              <div className="text-xs font-bold text-success-strong">활동 편입후보</div>
              <div className="text-[20px] font-extrabold text-success-strong">{data.activeCount}</div>
              <div className="text-xs text-success">선택 후 이름·전화 편입</div>
            </div>
            <div className="rounded-2xl border border-border-strong bg-background p-3">
              <div className="text-xs font-bold text-muted-foreground">비활동 · 사전 동의 필요</div>
              <div className="text-[20px] font-extrabold text-gray-700">{data.inactiveCount}</div>
              <div className="text-xs text-muted-foreground">집계만 · 현재 편입 제외</div>
            </div>
            <div className="rounded-2xl border border-border-strong bg-card p-3">
              <div className="text-xs font-bold text-muted-foreground">이미 지원자</div>
              <div className="text-[20px] font-extrabold text-gray-700">{data.excludedApplicants}</div>
              <div className="text-xs text-muted-foreground">중복 제외</div>
            </div>
            <div className="rounded-2xl border border-border-strong bg-card p-3">
              <div className="text-xs font-bold text-muted-foreground">블랙리스트</div>
              <div className="text-[20px] font-extrabold text-gray-700">{data.excludedBlacklist}</div>
              <div className="text-xs text-muted-foreground">재채용 불가 제외</div>
            </div>
          </div>

          {/* 법적 주의 */}
          <div className="flex items-start gap-2 px-4 py-3 rounded-2xl bg-warning-soft border border-warning/30 text-xs text-warning-strong">
            <ShieldAlert size={15} className="shrink-0 mt-0.5" />
            <span>
              이 화면의 실행은 <b>선택한 후보의 이름·전화번호 편입까지</b>입니다. 문자 발송·근무 배정·근무 확정은 하지 않습니다. 후속 안내는 수신 동의와 법적 근거를 별도로 검토해야 합니다.
            </span>
          </div>

          {/* 편입 실행 */}
          <div className="flex flex-wrap items-center gap-3">
            {/* 잠금이면 버튼도 잠가 보인다 — 예전엔 기능 스위치가 꺼져 있어도 버튼이 활성처럼
                보여서, 누르고 나서야 "잠겨 있어요" 토스트를 받았다. 상태와 겉모습을 일치시킨다.
                색도 화면마다 다르던 주 버튼(여기만 녹색)을 핵심 실행=Ink 규칙으로 통일. */}
            <Button
              onClick={runImport}
              disabled={importing || selectedCount === 0 || !data.enabled}
              title={!data.enabled ? "'다시 부르기'가 꺼져 있어요 — 설정에서 켜면 편입할 수 있습니다" : undefined}
            >
              {importing ? <Loader2 size={15} className="animate-spin" /> : !data.enabled ? <Lock size={15} /> : <UserPlus size={15} />}
              선택 {selectedCount}명 편입{!data.enabled ? " (잠김)" : ""}
            </Button>
            <span className="text-xs text-muted-foreground">
              편입 후 발송은 발송 플로에서 매니저가 진행(블랙리스트·수신거부 하드 가드 적용).
            </span>
          </div>

          {/* 첫 접촉 문구(자리표시 — 실운영 전 검토) */}
          <div className="grid sm:grid-cols-2 gap-2">
            <div className="rounded-2xl border border-border-strong bg-surface-raised p-3 space-y-1">
              <div className="text-[12px] font-bold text-success-strong">활동자 · 기회 안내 문구</div>
              <div className="text-[12px] text-gray-700 leading-relaxed">{data.templates.offer}</div>
            </div>
            <div className="rounded-2xl border border-border-strong bg-surface-raised p-3 space-y-1">
              <div className="text-[12px] font-bold text-muted-foreground">비활동자 · 사전 동의 요청 문구</div>
              <div className="text-[12px] text-gray-700 leading-relaxed">{data.templates.optin}</div>
            </div>
          </div>

          {/* 활동 후보 목록(이름 + 마스킹 전화) */}
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5 text-[13px] font-bold text-gray-700">
                <Users size={14} /> 활동 편입후보 {data.activeCandidates.length}명 · 선택 {selectedCount}명
              </div>
              {data.activeCandidates.length > 0 && (
                <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-2 text-xs font-bold text-muted-foreground hover:bg-muted focus-within:ring-2 focus-within:ring-ring">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="size-4 accent-foreground"
                  />
                  전체 선택
                </label>
              )}
            </div>
            {data.activeCandidates.length === 0 ? (
              <div className="text-[13px] text-muted-foreground py-4 text-center">편입 가능한 활동 후보가 없어요.</div>
            ) : (
              <div className="rounded-2xl border border-border-strong divide-y divide-muted overflow-hidden">
                {data.activeCandidates.map((c) => (
                  <label key={c.key} className="flex min-h-14 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 bg-card px-4 py-2.5 hover:bg-muted/60 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
                    <input
                      type="checkbox"
                      checked={selectedKeys.has(c.key)}
                      onChange={() => toggleCandidate(c.key)}
                      className="size-4 shrink-0 accent-foreground"
                      aria-label={`${c.name ?? "이름 미상"} 편입 선택`}
                    />
                    <span className="font-bold text-[13px] text-foreground">{c.name ?? "(이름 미상)"}</span>
                    <span className="text-xs text-muted-foreground">{c.phoneMasked}</span>
                    <span className="ml-auto flex gap-1">
                      {c.sources.map((s) => (
                        <span
                          key={s}
                          className="text-xs font-bold px-1.5 py-0.5 rounded-full bg-muted text-gray-700"
                        >
                          {SRC_LABEL[s] ?? s}
                        </span>
                      ))}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </PageShell>
  );
}
