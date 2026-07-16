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
        `활동 편입후보 ${data?.activeCount ?? 0}명을 인력풀에 편입할까요?\n(스위치 OFF면 잠겨서 아무 것도 반입되지 않아요.)`
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
        toast.info(json.note || "재활용 스위치 OFF — 편입 잠금(미리보기만)");
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
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-extrabold text-[#1A202C] flex items-center gap-2">
            <RefreshCw size={20} /> 재활용 · 배송원 재편입
          </h1>
          <p className="text-[13px] text-[#718096] mt-1">
            옹고잉·옹매니징 배송원 중 옹보딩 미지원자를 인력풀 후보로 (블랙리스트 제외)
          </p>
        </div>
        {triggered && (
          <button
            onClick={() => mutate()}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-bold text-[#4A5568] border border-[#E2E8F0] hover:bg-[#F7FAFC] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
          >
            <RefreshCw size={14} /> 다시 발굴
          </button>
        )}
      </div>

      {!triggered && (
        <div className="rounded-xl border border-[#E2E8F0] bg-[#F7FAFC] p-5 text-center space-y-3">
          <p className="text-[13px] text-[#4A5568] leading-relaxed">
            옹고잉·옹매니징 DB를 조회해 재활용 후보를 발굴합니다. 외부 DB 접속이라 자동 실행하지 않아요.
          </p>
          <button
            onClick={() => setTriggered(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-bold text-white bg-[#2F855A] hover:bg-[#276749] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
          >
            <RefreshCw size={15} /> 재활용 후보 발굴하기
          </button>
        </div>
      )}

      {error && (
        <div className="px-4 py-3 rounded-xl bg-[#FFF5F5] border border-[#FEB2B2] text-[13px] font-semibold text-[#C53030]">
          발굴에 실패했어요.
        </div>
      )}
      {!error && data && !data.configured && (
        <div className="px-4 py-3 rounded-xl bg-[#EDF2F7] border border-[#E2E8F0] text-[13px] font-semibold text-[#718096]">
          옹고잉·옹매니징 미연동 — 재활용 후보를 발굴할 수 없어요.
        </div>
      )}
      {isLoading && (
        <div className="flex items-center gap-2 text-[13px] font-bold text-[#718096]">
          <Loader2 size={16} className="animate-spin" /> 후보를 발굴하는 중…
        </div>
      )}

      {data?.configured && (
        <>
          {/* 킬스위치 상태 */}
          <div
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[12.5px] font-bold border ${
              data.enabled
                ? "bg-[#F0FFF4] border-[#C6F6D5] text-[#2F855A]"
                : "bg-[#FFFBEB] border-[#F6E05E] text-[#B7791F]"
            }`}
          >
            <Lock size={14} />
            {data.enabled
              ? "재활용 스위치 ON — 편입 가능"
              : "재활용 스위치 OFF — 편입 잠금(미리보기만). 법적 검토·승인 후 스위치를 켜세요."}
          </div>

          {/* 요약 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-xl border border-[#C6F6D5] bg-[#F0FFF4] p-3">
              <div className="text-[11px] font-bold text-[#2F855A]">활동 편입후보</div>
              <div className="text-[20px] font-extrabold text-[#276749]">{data.activeCount}</div>
              <div className="text-[10.5px] text-[#68A17F]">이름+전화 반입</div>
            </div>
            <div className="rounded-xl border border-[#E2E8F0] bg-[#F7FAFC] p-3">
              <div className="text-[11px] font-bold text-[#718096]">비활동 옵트인후보</div>
              <div className="text-[20px] font-extrabold text-[#4A5568]">{data.inactiveCount}</div>
              <div className="text-[10.5px] text-[#A0AEC0]">집계만 (동의 후 반입)</div>
            </div>
            <div className="rounded-xl border border-[#E2E8F0] bg-white p-3">
              <div className="text-[11px] font-bold text-[#718096]">이미 지원자</div>
              <div className="text-[20px] font-extrabold text-[#4A5568]">{data.excludedApplicants}</div>
              <div className="text-[10.5px] text-[#A0AEC0]">중복 제외</div>
            </div>
            <div className="rounded-xl border border-[#E2E8F0] bg-white p-3">
              <div className="text-[11px] font-bold text-[#718096]">블랙리스트</div>
              <div className="text-[20px] font-extrabold text-[#4A5568]">{data.excludedBlacklist}</div>
              <div className="text-[10.5px] text-[#A0AEC0]">재채용 불가 제외</div>
            </div>
          </div>

          {/* 법적 주의 */}
          <div className="flex items-start gap-2 px-4 py-2.5 rounded-xl bg-[#FFF5F5] border border-[#FEB2B2] text-[12px] text-[#C53030]">
            <ShieldAlert size={15} className="shrink-0 mt-0.5" />
            <span>
              비지원자에게 보내는 첫 안내입니다. <b>활동자는 바로 안내(+수신거부 고지)</b>, 비활동자는{" "}
              <b>옵트인 먼저</b>. 실발송 전 <b>법적 근거 검토</b>를 권합니다.
            </span>
          </div>

          {/* 편입 실행 */}
          <div className="flex items-center gap-3">
            <button
              onClick={runImport}
              disabled={importing || data.activeCount === 0}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-bold text-white bg-[#2F855A] hover:bg-[#276749] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] disabled:opacity-50"
            >
              {importing ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
              활동 편입후보 {data.activeCount}명 편입
            </button>
            <span className="text-[11.5px] text-[#A0AEC0]">
              편입 후 발송은 발송 플로에서 매니저가 진행(블랙리스트·수신거부 하드 가드 적용).
            </span>
          </div>

          {/* 첫 접촉 문구(자리표시 — 실운영 전 검토) */}
          <div className="grid sm:grid-cols-2 gap-2">
            <div className="rounded-xl border border-[#E2E8F0] bg-[#FAFCFF] p-3 space-y-1">
              <div className="text-[11.5px] font-bold text-[#2F855A]">활동자 · 기회 안내 문구</div>
              <div className="text-[12px] text-[#4A5568] leading-relaxed">{data.templates.offer}</div>
            </div>
            <div className="rounded-xl border border-[#E2E8F0] bg-[#FAFCFF] p-3 space-y-1">
              <div className="text-[11.5px] font-bold text-[#718096]">비활동자 · 옵트인 문구</div>
              <div className="text-[12px] text-[#4A5568] leading-relaxed">{data.templates.optin}</div>
            </div>
          </div>

          {/* 활동 후보 목록(이름 + 마스킹 전화) */}
          <div>
            <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-[#4A5568] mb-2">
              <Users size={14} /> 활동 편입후보 {data.activeCandidates.length}명
            </div>
            {data.activeCandidates.length === 0 ? (
              <div className="text-[13px] text-[#A0AEC0] py-4 text-center">편입 가능한 활동 후보가 없어요.</div>
            ) : (
              <div className="rounded-xl border border-[#E2E8F0] divide-y divide-[#EDF2F7] overflow-hidden">
                {data.activeCandidates.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5 bg-white">
                    <span className="font-bold text-[13px] text-[#1A202C]">{c.name ?? "(이름 미상)"}</span>
                    <span className="text-[12px] text-[#718096]">{c.phoneMasked}</span>
                    <span className="ml-auto flex gap-1">
                      {c.sources.map((s) => (
                        <span
                          key={s}
                          className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#EDF2F7] text-[#4A5568]"
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
