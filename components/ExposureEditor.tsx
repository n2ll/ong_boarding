"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Loader2, Users, UserX, RotateCcw, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { jsonFetcher } from "@/lib/swr";
import { useConfirm } from "./ConfirmDialog";
import { VEHICLE_RULE_VALUES, UNKNOWN_RULE_VALUE, SIGUNGU_NO_SIDO } from "@/lib/exposure";

/**
 * J · 타겟 공고 노출 편집기 — 공고 생성 폼·수정 모달 공용.
 *
 * - 노출 방식 토글(전체/지정) + 규칙 빌더(지역·가용성·차량·선탑완료·등록 시점) + "해당 N명" 실시간 미리보기.
 * - jobId가 있으면(수정 모달) 서버에 '저장된' 기준의 유효 노출 명단 + 개별 제외/복원까지 제공.
 * - 값 저장은 부모가 한다(jobs POST/PATCH의 exposure·exposure_rule) — 이 컴포넌트는 편집·미리보기 담당.
 * - 확정 뉘앙스 금지: '노출 대상'은 공고를 보여줄 사람일 뿐, 배정·확정이 아니다.
 */

export interface ExposureRuleDraft {
  sido: string[];
  /** 시군구(구 단위) — 시·도로는 권역을 못 가른다. '미확인'을 고르면 시군구 값이 없는 사람도 포함된다. */
  sigungu: string[];
  availability: string[];
  /** 차량 보유('있음'·'없음'·'미확인') — 공고 요건과 직결되는 축. 비우면 차량과 무관하게 노출. */
  vehicle: string[];
  suntopDone: boolean;
  cohortMonths: number | "";
}

export interface ExposureDraft {
  exposure: "all" | "targeted";
  rule: ExposureRuleDraft;
}

export const EMPTY_EXPOSURE: ExposureDraft = {
  exposure: "all",
  rule: { sido: [], sigungu: [], availability: [], vehicle: [], suntopDone: false, cohortMonths: "" },
};

/** 서버(jsonb)의 exposure_rule → 편집용 draft. */
export function ruleToDraft(raw: unknown): ExposureRuleDraft {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    sido: Array.isArray(r.sido) ? r.sido.filter((v): v is string => typeof v === "string") : [],
    sigungu: Array.isArray(r.sigungu) ? r.sigungu.filter((v): v is string => typeof v === "string") : [],
    availability: Array.isArray(r.availability)
      ? r.availability.filter((v): v is string => typeof v === "string")
      : [],
    vehicle: Array.isArray(r.vehicle) ? r.vehicle.filter((v): v is string => typeof v === "string") : [],
    suntopDone: r.suntopDone === true,
    cohortMonths: typeof r.cohortMonths === "number" && r.cohortMonths > 0 ? r.cohortMonths : "",
  };
}

/** 편집 draft → 저장용 jsonb(빈 규칙이면 null). 서버 normalizeRule과 같은 방향. */
export function draftToRule(d: ExposureRuleDraft): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (d.sido.length) out.sido = d.sido;
  if (d.sigungu.length) out.sigungu = d.sigungu;
  if (d.availability.length) out.availability = d.availability;
  if (d.vehicle.length) out.vehicle = d.vehicle;
  if (d.suntopDone) out.suntopDone = true;
  if (typeof d.cohortMonths === "number" && d.cohortMonths > 0) out.cohortMonths = d.cohortMonths;
  return Object.keys(out).length ? out : null;
}

interface RosterPerson {
  id: number;
  name: string | null;
  via: "rule" | "include" | "both";
  /** 이 공고로 이야기 중(관심·후보, 이탈 제외) — 명단에서 빼면 본인 화면에서 공고가 사라진다. */
  linked?: boolean;
  /** 노출을 좁힐 때 시스템이 자동으로 남긴 행(added_by='auto_linked') — 매니저가 고른 인원과 구분. */
  auto?: boolean;
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
  const confirm = useConfirm();
  const targeted = value.exposure === "targeted";

  // 규칙 빌더 옵션 — 실데이터 distinct 값(지정 노출을 켰을 때만 로드)
  const { data: options } = useSWR<{
    sidos: string[];
    availabilities: string[];
    sigunguGroups?: { sido: string; items: { name: string; count: number; key: string }[] }[];
    unknown?: { sido: number; sigungu: number };
  }>(
    targeted ? "/api/admin/exposure" : null,
    jsonFetcher,
    { revalidateOnFocus: false }
  );

  // "규칙 해당 N명" 미리보기 — draft 규칙 변경을 500ms 디바운스해 POST
  const [preview, setPreview] = useState<{ count: number; total: number; sample: string[] } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // 미리보기 조회 실패를 '규칙 비어 있음'과 구분(D12) — 에러를 빈 규칙으로 위장하지 않는다.
  const [previewError, setPreviewError] = useState(false);
  const ruleJson = useMemo(() => JSON.stringify(draftToRule(value.rule)), [value.rule]);
  const previewSeq = useRef(0);
  useEffect(() => {
    // 매 실행마다 seq 증가 — 규칙을 비우거나 targeted를 끄는 early-return 경로도
    // in-flight 응답을 무효화해야 stale 카운트·스피너 고착이 없다.
    const seq = ++previewSeq.current;
    if (!targeted) {
      setPreview(null);
      setPreviewLoading(false);
      setPreviewError(false);
      return;
    }
    const rule = JSON.parse(ruleJson);
    if (!rule) {
      setPreview(null);
      setPreviewLoading(false);
      setPreviewError(false);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(false);
    const timer = setTimeout(() => {
      fetch("/api/admin/exposure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((json) => {
          if (previewSeq.current === seq) { setPreview(json); setPreviewError(false); }
        })
        .catch(() => {
          // 실패는 '규칙 비어 있음'이 아니라 '조회 오류'로 구분 표시(D12).
          if (previewSeq.current === seq) { setPreview(null); setPreviewError(true); }
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
  const overrideCall = async (
    applicantId: number,
    action: "exclude" | "remove-include" | "restore",
    linked = false
  ) => {
    if (!jobId || rosterBusy) return;
    // 이야기 중인 분을 빼는 건 되돌리기 어려운 결과(본인 화면에서 공고가 사라지는데 AI 응대는 계속된다)
    // → 한 단계 확인. 확정 뉘앙스 없이 사실만 말한다.
    if (linked && action !== "restore") {
      const ok = await confirm({
        title: "이 분은 지금 이 공고로 이야기 중이에요",
        description:
          // 저장된 노출이 '전체'면 아직 명단이 효력을 갖지 않는다 — 사라진다고 단정하지 않는다.
          (roster?.exposure === "targeted"
            ? "명단에서 빼면 본인 맞춤 공고 링크에서 이 공고가 사라져요. AI 응대는 계속되기 때문에, 지원자는 볼 수 없는 공고를 이야기하는 상태가 됩니다."
            : "이 공고는 지금 '전체 노출'이라 바로 사라지지는 않지만, 나중에 '지정 노출'로 바꾸는 순간 이 분에게 공고가 보이지 않게 됩니다(AI 응대는 계속됩니다).") +
          "\n제외로 기록되므로 노출을 좁힐 때 자동으로 되살아나지 않아요. 되돌리려면 아래 '제외해둔 인원'에서 복원하세요.",
        confirmText: "그래도 빼기",
        destructive: true,
      });
      if (!ok) return;
    }
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
        <label className="block text-[13px] font-bold text-[#4A5568] mb-2">노출 방식</label>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["all", "전체 노출", "인재풀 전원의 맞춤 공고 링크에 노출(기본)"],
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
          {/* 역방향 동선 — 여기 있는 축(지역·가용성·차량…)으로 안 잡히는 대상은 인재풀에서 직접 골라야 한다.
              **저장된 공고(jobId)에서만** 안내한다 — 등록 폼에서 이 링크를 타면 작성 중 내용을 잃고,
              아직 공고가 없어 명단을 만들 수도 없다. */}
          {jobId && (
          <p className="text-[11px] text-[#718096] leading-snug">
            여기 조건으로 못 가르는 대상이면{" "}
            <a
              href="/pipeline"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-[#2B6CB0] underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] rounded"
            >
              인재풀에서 조건으로 고른 뒤 &lsquo;이 명단에게만 노출&rsquo;
            </a>
            을 쓰세요. 새 탭에서 열려요 — <b className="text-[#B7791F]">거기서 노출을 바꾸면 이 창의 노출 값은 옛 값이 됩니다.</b> 돌아와서는 이 창을 닫고 다시 열어 주세요.
          </p>
          )}

          <div>
            <div className="text-[11.5px] font-bold text-[#A0AEC0] mb-1.5">지역(시도)</div>
            <div className="flex flex-wrap gap-1.5">
              {(options?.sidos ?? []).map((s) => (
                <Chip key={s} label={s} on={value.rule.sido.includes(s)} onClick={() => setRule({ sido: toggleIn(value.rule.sido, s) })} />
              ))}
              {/* 값이 없는 사람도 포함할 수 있게 — 안 고르면 그 인원은 이 조건에서 조용히 빠진다 */}
              {(options?.unknown?.sido ?? 0) > 0 && (
                <Chip
                  label={`미확인 ${options?.unknown?.sido}`}
                  on={value.rule.sido.includes(UNKNOWN_RULE_VALUE)}
                  onClick={() => setRule({ sido: toggleIn(value.rule.sido, UNKNOWN_RULE_VALUE) })}
                />
              )}
              {options && options.sidos.length === 0 && <span className="text-[12px] text-[#A0AEC0]">지역 데이터 없음</span>}
            </div>
          </div>

          {/* 시군구(구 단위) — 시·도로는 강남권/용산권을 못 가른다. 동명이구(중구·서구)가 있어 시도별로 묶어 보여준다. */}
          <div>
            <div className="text-[11.5px] font-bold text-[#A0AEC0] mb-1.5">
              시군구 <span className="font-semibold text-[#CBD5E0]">— 권역별 라인이면 여기서 구를 고르세요</span>
            </div>
            <div className="flex flex-col gap-2">
              {(options?.sigunguGroups ?? []).map((g) => (
                <div key={g.sido}>
                  <div className="text-[10.5px] font-bold text-[#CBD5E0] mb-1">
                    {g.sido}
                    {g.sido === SIGUNGU_NO_SIDO && <span className="font-semibold"> — 주소 정리가 필요한 분들</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {g.items.map((it) => (
                      <Chip
                        key={it.key}
                        label={`${it.name} ${it.count}`}
                        /* 저장 값은 '시도>시군구' 복합키 — 이름만 담으면 동명이구(중구·서구)가 교차로 걸려
                           화면의 시도 그룹과 실제 판정 범위가 어긋난다. */
                        on={value.rule.sigungu.includes(it.key)}
                        onClick={() => setRule({ sigungu: toggleIn(value.rule.sigungu, it.key) })}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {(options?.unknown?.sigungu ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  <Chip
                    label={`미확인 ${options?.unknown?.sigungu}`}
                    on={value.rule.sigungu.includes(UNKNOWN_RULE_VALUE)}
                    onClick={() => setRule({ sigungu: toggleIn(value.rule.sigungu, UNKNOWN_RULE_VALUE) })}
                  />
                </div>
              )}
              {options && (options.sigunguGroups ?? []).length === 0 && (
                <span className="text-[12px] text-[#A0AEC0]">시군구 데이터 없음</span>
              )}
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

          <div>
            <div className="text-[11.5px] font-bold text-[#A0AEC0] mb-1.5">
              차량 <span className="font-semibold text-[#CBD5E0]">— 차량이 필요한 라인이면 '있음'만 골라 주세요</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {VEHICLE_RULE_VALUES.map((s) => (
                <Chip key={s} label={s} on={value.rule.vehicle.includes(s)} onClick={() => setRule({ vehicle: toggleIn(value.rule.vehicle, s) })} />
              ))}
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
            ) : previewError ? (
              <span className="text-[#C53030]">미리보기를 불러오지 못했어요 — 규칙을 바꾸면 다시 시도돼요.</span>
            ) : preview ? (
              <span className="text-[#2B6CB0]">
                규칙 해당 {preview.count}명 <span className="text-[#A0AEC0] font-semibold">/ 전체 {preview.total}명{preview.sample.length > 0 ? ` · 예: ${preview.sample.join(", ")}` : ""} · 편집 중 규칙 기준</span>
              </span>
            ) : !jobId ? (
              // 등록 시점(jobId 없음)엔 수동 명단이 없어 빈 규칙=노출 0명 → 강한 경고(D11).
              <span className="text-[#DD6B20]">⚠️ 지정 노출인데 규칙이 비어 있어요 — 등록 후 파이프라인에서 노출 대상을 추가하지 않으면 아무에게도 안 보입니다.</span>
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
              title="저장된 기준 명단을 다시 불러옵니다(파이프라인에서 추가한 인원 등 반영). 편집 중 규칙 변경은 저장 후 다음에 열 때 반영돼요."
            >
              <RefreshCw size={12} /> 새로고침
            </button>
          </div>
          <p className="text-[11px] text-[#A0AEC0] leading-snug">이 명단은 <b className="text-[#718096]">저장된 규칙</b> 기준이에요(위 &lsquo;규칙 해당 N명&rsquo;은 편집 중 기준이라 다를 수 있어요). 규칙을 바꿔 저장하면 다음에 열 때 반영됩니다. <b className="text-[#718096]">제외·복원은 누르는 즉시 적용</b>돼요(규칙과 달리 저장 불필요). 수동 추가는{" "}
            <a href="/pipeline" target="_blank" rel="noopener noreferrer" className="font-bold text-[#2B6CB0] underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] rounded">인재풀에서 인원 선택 → &lsquo;이 명단에게만 노출&rsquo;</a>.</p>
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
                      <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#EDF2F7] text-[#718096]">{p.auto ? "자동" : VIA_LABEL[p.via]}</span>
                      {/* 이야기 중인 분을 '수동 추가'와 같게 보여주면, 클릭 한 번에 보호가 사라진다 */}
                      {p.linked && (
                        <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#FFFAF0] text-[#C05621] border border-[#FBD38D]" title="이 공고로 관심을 누르거나 후보로 진행 중인 분이에요. 명단에서 빼면 본인 맞춤 공고 링크에서 이 공고가 사라집니다.">
                          이 공고로 이야기 중
                        </span>
                      )}
                      <button
                        type="button"
                        /* 이야기 중인 분은 **행 삭제(remove-include)가 아니라 exclude**로 뺀다 —
                           삭제만 하면 다음 노출 축소 때 자동 보호가 같은 사람을 다시 넣어, 확인 문구와 반대로 조용히 되돌아간다. */
                        onClick={() => overrideCall(p.id, p.via === "include" && !p.linked ? "remove-include" : "exclude", p.linked === true)}
                        disabled={rosterBusy}
                        title={p.linked ? "이 분은 이 공고로 이야기 중이에요 — 빼면 본인 화면에서 공고가 사라지고 AI 응대는 계속됩니다(확인 후 적용)" : p.via === "include" ? "수동 추가를 해제합니다(규칙 비매칭이라 노출 대상에서 빠져요)" : "규칙보다 우선하는 '제외'로 지정합니다"}
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
                        {/* 제외됐는데 이야기 중인 분 — AI만 그 공고를 말하는 상태다. 여기서 발견·복원할 수 있어야 한다. */}
                        {p.linked && (
                          <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#FFF5F5] text-[#C53030] border border-[#FEB2B2]" title="이 분은 이 공고로 이야기 중인데 노출에서 제외돼 있어요 — 본인 화면에서는 이 공고를 볼 수 없습니다.">
                            이야기 중인데 제외됨
                          </span>
                        )}
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
