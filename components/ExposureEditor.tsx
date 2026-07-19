"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Loader2, Users, UserX, RotateCcw, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { jsonFetcher } from "@/lib/swr";

/**
 * J · 타겟 공고 노출 편집기 — 공고 생성 폼·수정 모달 공용.
 *
 * - 노출 범위 토글(전체/지정) + 규칙 빌더(지역·가용성·선탑완료·코호트) + "해당 N명" 실시간 미리보기.
 * - jobId가 있으면(수정 모달) 서버에 '저장된' 기준의 유효 노출 명단 + 개별 제외/복원까지 제공.
 * - 값 저장은 부모가 한다(jobs POST/PATCH의 exposure·exposure_rule) — 이 컴포넌트는 편집·미리보기 담당.
 * - 확정 뉘앙스 금지: '노출 대상'은 공고를 보여줄 사람일 뿐, 배정·확정이 아니다.
 */

export interface ExposureRuleDraft {
  sido: string[];
  availability: string[];
  suntopDone: boolean;
  cohortMonths: number | "";
}

export interface ExposureDraft {
  exposure: "all" | "targeted";
  rule: ExposureRuleDraft;
}

export const EMPTY_EXPOSURE: ExposureDraft = {
  exposure: "all",
  rule: { sido: [], availability: [], suntopDone: false, cohortMonths: "" },
};

/** 서버(jsonb)의 exposure_rule → 편집용 draft. */
export function ruleToDraft(raw: unknown): ExposureRuleDraft {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    sido: Array.isArray(r.sido) ? r.sido.filter((v): v is string => typeof v === "string") : [],
    availability: Array.isArray(r.availability)
      ? r.availability.filter((v): v is string => typeof v === "string")
      : [],
    suntopDone: r.suntopDone === true,
    cohortMonths: typeof r.cohortMonths === "number" && r.cohortMonths > 0 ? r.cohortMonths : "",
  };
}

/** 편집 draft → 저장용 jsonb(빈 규칙이면 null). 서버 normalizeRule과 같은 방향. */
export function draftToRule(d: ExposureRuleDraft): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (d.sido.length) out.sido = d.sido;
  if (d.availability.length) out.availability = d.availability;
  if (d.suntopDone) out.suntopDone = true;
  if (typeof d.cohortMonths === "number" && d.cohortMonths > 0) out.cohortMonths = d.cohortMonths;
  return Object.keys(out).length ? out : null;
}

interface RosterPerson {
  id: number;
  name: string | null;
  via: "rule" | "include" | "both";
}
interface RosterResp {
  exposure: string;
  effective: RosterPerson[];
  excluded: RosterPerson[];
  counts: { effective: number; by_rule: number; manual_include: number; excluded: number };
}

const VIA_LABEL: Record<RosterPerson["via"], string> = {
  rule: "규칙",
  include: "수동",
  both: "규칙+수동",
};

function Chip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-lg text-[12px] font-bold border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] ${
        on
          ? "bg-[#1A202C] text-white border-[#1A202C]"
          : "bg-white text-[#4A5568] border-[#E2E8F0] hover:border-[#CBD5E0]"
      }`}
    >
      {label}
    </button>
  );
}

export function ExposureEditor({
  value,
  onChange,
  jobId,
}: {
  value: ExposureDraft;
  onChange: (next: ExposureDraft) => void;
  jobId?: number;
}) {
  const targeted = value.exposure === "targeted";

  // 규칙 빌더 옵션 — 실데이터 distinct 값(지정 노출을 켰을 때만 로드)
  const { data: options } = useSWR<{ sidos: string[]; availabilities: string[] }>(
    targeted ? "/api/admin/exposure" : null,
    jsonFetcher,
    { revalidateOnFocus: false }
  );

  // "규칙 해당 N명" 미리보기 — draft 규칙 변경을 500ms 디바운스해 POST
  const [preview, setPreview] = useState<{ count: number; total: number; sample: string[] } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const ruleJson = useMemo(() => JSON.stringify(draftToRule(value.rule)), [value.rule]);
  const previewSeq = useRef(0);
  useEffect(() => {
    // 매 실행마다 seq 증가 — 규칙을 비우거나 targeted를 끄는 early-return 경로도
    // in-flight 응답을 무효화해야 stale 카운트·스피너 고착이 없다.
    const seq = ++previewSeq.current;
    if (!targeted) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    const rule = JSON.parse(ruleJson);
    if (!rule) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      fetch("/api/admin/exposure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((json) => {
          if (previewSeq.current === seq) setPreview(json);
        })
        .catch(() => {
          if (previewSeq.current === seq) setPreview(null);
        })
        .finally(() => {
          if (previewSeq.current === seq) setPreviewLoading(false);
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [targeted, ruleJson]);

  // 유효 노출 명단(수정 모달 전용) — 서버에 '저장된' exposure/rule 기준
  const {
    data: roster,
    isLoading: rosterLoading,
    mutate: mutateRoster,
  } = useSWR<RosterResp>(
    targeted && jobId ? `/api/admin/jobs/${jobId}/exposure` : null,
    jsonFetcher,
    { revalidateOnFocus: false }
  );
  const [rosterBusy, setRosterBusy] = useState(false);

  // 제외의 두 갈래: 순수 수동 include(via='include')는 행 삭제(DELETE)로 되돌린다 — exclude로
  // 덮어쓰면 include 이력이 소실돼 복원이 불가능해진다. 규칙 매칭(rule/both)은 exclude 오버라이드.
  const overrideCall = async (applicantId: number, action: "exclude" | "remove-include" | "restore") => {
    if (!jobId || rosterBusy) return;
    setRosterBusy(true);
    try {
      const isDelete = action !== "exclude";
      const res = await fetch("/api/admin/exposure/bulk", {
        method: isDelete ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_ids: [jobId],
          applicant_ids: [applicantId],
          ...(isDelete ? {} : { mode: "exclude" }),
        }),
      });
      if (!res.ok) {
        toast.error(action === "restore" ? "복원에 실패했어요" : "제외에 실패했어요");
        return;
      }
      toast.success(
        action === "restore" ? "제외를 해제했어요" : action === "remove-include" ? "수동 추가를 해제했어요" : "이 공고에서 제외했어요"
      );
      await mutateRoster();
    } finally {
      setRosterBusy(false);
    }
  };

  const setRule = (patch: Partial<ExposureRuleDraft>) =>
    onChange({ ...value, rule: { ...value.rule, ...patch } });
  const toggleIn = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[13px] font-bold text-[#4A5568] mb-2">노출 범위</label>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["all", "전체 노출", "인재풀 전원의 맞춤링크에 노출(기본)"],
              ["targeted", "지정 노출", "아래 규칙·수동 지정 대상에게만 노출"],
            ] as ["all" | "targeted", string, string][]
          ).map(([k, label, desc]) => {
            const sel = value.exposure === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => onChange({ ...value, exposure: k })}
                className={`text-left p-3 rounded-xl border transition-colors ${
                  sel
                    ? "border-[#1A202C] bg-white ring-1 ring-[#1A202C]"
                    : "border-[#E2E8F0] bg-white hover:border-[#CBD5E0]"
                }`}
              >
                <div className={`text-[13px] font-bold ${sel ? "text-[#1A202C]" : "text-[#4A5568]"}`}>{label}</div>
                <div className="text-[11px] text-[#A0AEC0] mt-0.5 leading-snug">{desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {targeted && (
        <div className="rounded-xl border border-[#E2E8F0] bg-[#FAFCFF] p-3.5 space-y-3">
          <div className="text-[12.5px] font-bold text-[#4A5568]">자동 노출 규칙 — 조건에 맞는 인원에게 자동 노출 (비우면 수동 지정만)</div>

          <div>
            <div className="text-[11.5px] font-bold text-[#A0AEC0] mb-1.5">지역(시도)</div>
            <div className="flex flex-wrap gap-1.5">
              {(options?.sidos ?? []).map((s) => (
                <Chip key={s} label={s} on={value.rule.sido.includes(s)} onClick={() => setRule({ sido: toggleIn(value.rule.sido, s) })} />
              ))}
              {options && options.sidos.length === 0 && <span className="text-[12px] text-[#A0AEC0]">지역 데이터 없음</span>}
            </div>
          </div>

          <div>
            <div className="text-[11.5px] font-bold text-[#A0AEC0] mb-1.5">가용성</div>
            <div className="flex flex-wrap gap-1.5">
              {(options?.availabilities ?? []).map((s) => (
                <Chip key={s} label={s} on={value.rule.availability.includes(s)} onClick={() => setRule({ availability: toggleIn(value.rule.availability, s) })} />
              ))}
              {options && options.availabilities.length === 0 && <span className="text-[12px] text-[#A0AEC0]">가용성 데이터 없음</span>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-[12.5px] font-bold text-[#4A5568] cursor-pointer">
              <input
                type="checkbox"
                checked={value.rule.suntopDone}
                onChange={(e) => setRule({ suntopDone: e.target.checked })}
                className="accent-[#1A202C]"
              />
              선탑(동승) 완료자만
            </label>
            <label className="flex items-center gap-1.5 text-[12.5px] font-bold text-[#4A5568]">
              지원(등록)
              <input
                type="number"
                min={1}
                max={120}
                value={value.rule.cohortMonths}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  // 120 초과는 normalizeRule이 조용히 버리므로 입력 단계에서 클램프(표시-저장 불일치 방지)
                  setRule({ cohortMonths: e.target.value === "" || !Number.isFinite(n) || n <= 0 ? "" : Math.min(120, Math.floor(n)) });
                }}
                placeholder="없음"
                className="w-16 bg-white border border-[#E2E8F0] rounded-lg px-2 py-1 text-[12.5px] focus:outline-none focus:border-[#FFCB3C]"
              />
              개월 이내
            </label>
          </div>

          <div className="text-[12px] font-bold border-t border-[#EDF2F7] pt-2.5">
            {previewLoading ? (
              <span className="flex items-center gap-1.5 text-[#A0AEC0]"><Loader2 size={13} className="animate-spin" /> 해당 인원 계산 중…</span>
            ) : preview ? (
              <span className="text-[#2B6CB0]">
                규칙 해당 {preview.count}명 <span className="text-[#A0AEC0] font-semibold">/ 전체 {preview.total}명{preview.sample.length > 0 ? ` · 예: ${preview.sample.join(", ")}` : ""}</span>
              </span>
            ) : (
              <span className="text-[#A0AEC0]">규칙이 비어 있어요 — 수동 지정 대상에게만 노출됩니다.</span>
            )}
          </div>
        </div>
      )}

      {targeted && jobId && (
        <div className="rounded-xl border border-[#E2E8F0] bg-white p-3.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-[#4A5568]">
              <Users size={14} /> 노출 대상 명단
              {roster && (
                <span className="text-[#A0AEC0] font-semibold">
                  {roster.counts.effective}명 (규칙 {roster.counts.by_rule} · 수동 {roster.counts.manual_include})
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => mutateRoster()}
              className="flex items-center gap-1 text-[11.5px] font-bold text-[#718096] hover:text-[#1A202C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] rounded"
              title="저장된 규칙 기준 명단을 다시 불러옵니다 — 규칙을 바꿨다면 먼저 저장하세요"
            >
              <RefreshCw size={12} /> 새로고침
            </button>
          </div>
          <p className="text-[11px] text-[#A0AEC0] leading-snug">저장된 규칙 기준이에요. 위에서 규칙을 바꿨다면 저장 후 새로고침하세요. 수동 추가는 파이프라인에서 인원 선택 → &lsquo;노출 대상으로 추가&rsquo;.</p>
          {rosterLoading ? (
            <div className="flex items-center gap-2 text-[12px] text-[#A0AEC0]"><Loader2 size={13} className="animate-spin" /> 불러오는 중…</div>
          ) : roster ? (
            <>
              {roster.effective.length === 0 ? (
                <div className="text-[12px] text-[#A0AEC0] py-2">노출 대상이 없어요 — 규칙을 설정하거나 파이프라인에서 수동 추가하세요.</div>
              ) : (
                <div className="max-h-44 overflow-y-auto divide-y divide-[#F7FAFC]">
                  {roster.effective.map((p) => (
                    <div key={p.id} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                      <span className="font-bold text-[#1A202C]">{p.name ?? `#${p.id}`}</span>
                      <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#EDF2F7] text-[#718096]">{VIA_LABEL[p.via]}</span>
                      <button
                        type="button"
                        onClick={() => overrideCall(p.id, p.via === "include" ? "remove-include" : "exclude")}
                        disabled={rosterBusy}
                        title={p.via === "include" ? "수동 추가를 해제합니다(규칙 비매칭이라 노출 대상에서 빠져요)" : "규칙보다 우선하는 '제외'로 지정합니다"}
                        className="ml-auto flex items-center gap-1 text-[11px] font-bold text-[#C53030] hover:underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] rounded"
                      >
                        <UserX size={11} /> 제외
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {roster.excluded.length > 0 && (
                <div className="border-t border-[#EDF2F7] pt-2">
                  <div className="text-[11.5px] font-bold text-[#A0AEC0] mb-1">제외해둔 인원 {roster.excluded.length}명</div>
                  <div className="max-h-24 overflow-y-auto divide-y divide-[#F7FAFC]">
                    {roster.excluded.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 py-1 text-[12px] text-[#718096]">
                        <span className="font-semibold line-through">{p.name ?? `#${p.id}`}</span>
                        <button
                          type="button"
                          onClick={() => overrideCall(p.id, "restore")}
                          disabled={rosterBusy}
                          className="ml-auto flex items-center gap-1 text-[11px] font-bold text-[#2B6CB0] hover:underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] rounded"
                        >
                          <RotateCcw size={11} /> 복원
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
