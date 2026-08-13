"use client";

import { useState } from "react";
import useSWR from "swr";
import { RefreshCw, Loader2, Users, UserPlus, ShieldAlert, Lock } from "lucide-react";
import { toast } from "sonner";
import { jsonFetcher } from "@/lib/swr";

interface ActiveCandidate {
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
  // 외부 DB(옹고잉 AWS RDS 등) 조회라 페이지 로드·포커스마다 자동 호출하지 않는다 — 매니저가 명시적으로 발굴.
  const [triggered, setTriggered] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<Resp>(
    triggered ? "/api/admin/reengagement" : null,
    jsonFetcher,
    { revalidateOnFocus: false, revalidateOnReconnect: false }
  );
  const [importing, setImporting] = useState(false);

  const runImport = async () => {
    if (importing) return;
    if (
      !window.confirm(
        `활동 중인 후보 ${data?.activeCount ?? 0}명을 인력풀에 편입할까요?\n(‘다시 부르기’가 꺼져 있으면 잠겨서 아무 것도 반입되지 않아요.)`
      )
    )
      return;
    setImporting(true);
    try {
      const res = await fetch("/api/admin/reengagement", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "편입에 실패했어요");
        return;
      }
      if (json.enabled === false) {
        toast.info(json.note || "‘다시 부르기’가 꺼져 있어요 — 편입 잠금(미리보기만)");
      } else {
        toast.success(json.note || `${json.imported}명 편입 완료`);
        await mutate();
      }
    } catch {
      toast.error("편입에 실패했어요");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="p-8 pb-12 max-w-4xl w-full space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-extrabold text-foreground flex items-center gap-2">
            <RefreshCw size={20} /> 다시 부르기 (외부 인력)
          </h1>
          <p className="text-[13px] text-muted-foreground mt-1">
            옹고잉·옹매니징 배송원 중 옹보딩 미지원자를 인력풀 후보로 (블랙리스트 제외)
          </p>
        </div>
        {triggered && (
          <button
            onClick={() => mutate()}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-bold text-gray-700 border border-border-strong hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
          >
            <RefreshCw size={14} /> 다시 발굴
          </button>
        )}
      </div>

      {!triggered && (
        <div className="rounded-xl border border-border-strong bg-background p-5 text-center space-y-3">
          <p className="text-[13px] text-gray-700 leading-relaxed">
            옹고잉·옹매니징 DB를 조회해 다시 부를 만한 분을 찾습니다. 외부 DB 접속이라 자동 실행하지 않아요.
          </p>
          <button
            onClick={() => setTriggered(true)}
            className="min-h-11 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-bold text-white bg-success-strong hover:bg-success-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
          >
            <RefreshCw size={15} /> 다시 부를 분 찾기
          </button>
        </div>
      )}

      {error && (
        <div className="px-4 py-3 rounded-xl bg-error-soft border border-error/30 text-[13px] font-semibold text-error-strong">
          발굴에 실패했어요.
        </div>
      )}
      {!error && data && !data.configured && (
        <div className="px-4 py-3 rounded-xl bg-muted border border-border-strong text-[13px] font-semibold text-muted-foreground">
          옹고잉·옹매니징 미연동 — 다시 부를 분을 찾을 수 없어요.
        </div>
      )}
      {isLoading && (
        <div className="flex items-center gap-2 text-[13px] font-bold text-muted-foreground">
          <Loader2 size={16} className="animate-spin" /> 후보를 발굴하는 중…
        </div>
      )}

      {data?.configured && (
        <>
          {/* 킬스위치 상태 */}
          <div
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[12.5px] font-bold border ${
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
                <a href="/settings#switches" className="underline font-extrabold hover:text-warning-strong rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-700/40">
                  설정 › 기능 스위치
                </a>
                에서 켜 주세요.
              </span>
            )}
          </div>

          {/* 요약 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-xl border border-success/25 bg-success-soft p-3">
              <div className="text-[11px] font-bold text-success-strong">활동 편입후보</div>
              <div className="text-[20px] font-extrabold text-success-strong">{data.activeCount}</div>
              <div className="text-[10.5px] text-success">이름+전화 반입</div>
            </div>
            <div className="rounded-xl border border-border-strong bg-background p-3">
              <div className="text-[11px] font-bold text-muted-foreground">비활동 · 사전 동의 필요</div>
              <div className="text-[20px] font-extrabold text-gray-700">{data.inactiveCount}</div>
              <div className="text-[10.5px] text-muted-foreground">집계만 (동의 후 반입)</div>
            </div>
            <div className="rounded-xl border border-border-strong bg-white p-3">
              <div className="text-[11px] font-bold text-muted-foreground">이미 지원자</div>
              <div className="text-[20px] font-extrabold text-gray-700">{data.excludedApplicants}</div>
              <div className="text-[10.5px] text-muted-foreground">중복 제외</div>
            </div>
            <div className="rounded-xl border border-border-strong bg-white p-3">
              <div className="text-[11px] font-bold text-muted-foreground">블랙리스트</div>
              <div className="text-[20px] font-extrabold text-gray-700">{data.excludedBlacklist}</div>
              <div className="text-[10.5px] text-muted-foreground">재채용 불가 제외</div>
            </div>
          </div>

          {/* 법적 주의 */}
          <div className="flex items-start gap-2 px-4 py-2.5 rounded-xl bg-error-soft border border-error/30 text-[12px] text-error-strong">
            <ShieldAlert size={15} className="shrink-0 mt-0.5" />
            <span>
              비지원자에게 보내는 첫 안내입니다. <b>활동자는 바로 안내(+수신거부 고지)</b>, 비활동자는{" "}
              <b>사전 동의를 먼저</b> 받아야 해요. 실발송 전 <b>법적 근거 검토</b>를 권합니다.
            </span>
          </div>

          {/* 편입 실행 */}
          <div className="flex items-center gap-3">
            <button
              onClick={runImport}
              disabled={importing || data.activeCount === 0}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-bold text-white bg-success-strong hover:bg-success-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow disabled:opacity-50"
            >
              {importing ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
              활동 편입후보 {data.activeCount}명 편입
            </button>
            <span className="text-[11.5px] text-muted-foreground">
              편입 후 발송은 발송 플로에서 매니저가 진행(블랙리스트·수신거부 하드 가드 적용).
            </span>
          </div>

          {/* 첫 접촉 문구(자리표시 — 실운영 전 검토) */}
          <div className="grid sm:grid-cols-2 gap-2">
            <div className="rounded-xl border border-border-strong bg-surface-raised p-3 space-y-1">
              <div className="text-[11.5px] font-bold text-success-strong">활동자 · 기회 안내 문구</div>
              <div className="text-[12px] text-gray-700 leading-relaxed">{data.templates.offer}</div>
            </div>
            <div className="rounded-xl border border-border-strong bg-surface-raised p-3 space-y-1">
              <div className="text-[11.5px] font-bold text-muted-foreground">비활동자 · 사전 동의 요청 문구</div>
              <div className="text-[12px] text-gray-700 leading-relaxed">{data.templates.optin}</div>
            </div>
          </div>

          {/* 활동 후보 목록(이름 + 마스킹 전화) */}
          <div>
            <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-gray-700 mb-2">
              <Users size={14} /> 활동 편입후보 {data.activeCandidates.length}명
            </div>
            {data.activeCandidates.length === 0 ? (
              <div className="text-[13px] text-muted-foreground py-4 text-center">편입 가능한 활동 후보가 없어요.</div>
            ) : (
              <div className="rounded-xl border border-border-strong divide-y divide-muted overflow-hidden">
                {data.activeCandidates.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5 bg-white">
                    <span className="font-bold text-[13px] text-foreground">{c.name ?? "(이름 미상)"}</span>
                    <span className="text-[12px] text-muted-foreground">{c.phoneMasked}</span>
                    <span className="ml-auto flex gap-1">
                      {c.sources.map((s) => (
                        <span
                          key={s}
                          className="text-[10.5px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-gray-700"
                        >
                          {SRC_LABEL[s] ?? s}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
