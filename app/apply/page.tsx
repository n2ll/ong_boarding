"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { LogoMark } from "@/components/Logo";
import { SOURCE_LABELS } from "@/lib/applicant-source";

const TIMESLOTS = [
  { label: "평일 오전", sub: "월~금 09:00 ~ 14:00", value: "평일(월~금) 오전 타임 (09:00 ~ 14:00)" },
  { label: "평일 오후", sub: "월~금 12:00 ~ 17:00", value: "평일(월~금) 오후 타임 (12:00 ~ 17:00)" },
  { label: "주말 오전", sub: "토~일 09:00 ~ 14:00", value: "주말(토~일) 오전 타임 (09:00 ~ 14:00)" },
  { label: "주말 오후", sub: "토~일 12:00 ~ 17:00", value: "주말(토~일) 오후 타임 (12:00 ~ 17:00)" },
];

const LICENSE_TYPES = ["1종 보통", "2종 보통", "1종 대형", "없음"];

interface FormState {
  name: string;
  birthDate: string;
  phone: string;
  location: string;
  ownVehicle: string;
  licenseType: string;
  vehicleType: string;
  branch1: string;
  branch2: string;
  workHours: string[];
  experience: string;
  introduction: string;
  availableDate: string;
  selfOwnership: string;
  marketingConsent: boolean;
}

const INITIAL: FormState = {
  name: "",
  birthDate: "",
  phone: "",
  location: "",
  ownVehicle: "",
  licenseType: "",
  vehicleType: "",
  branch1: "",
  branch2: "",
  workHours: [],
  experience: "",
  introduction: "",
  availableDate: "",
  selfOwnership: "",
  marketingConsent: false,
};

// SOURCE_LABELS에 정의된 소스만 허용하고, 알 수 없는 값은 'direct'로 처리한다.
function normalizeSource(raw: string | null): string {
  if (raw && Object.prototype.hasOwnProperty.call(SOURCE_LABELS, raw)) return raw;
  return "direct";
}

function digits(raw: string, max: number): string {
  return raw.replace(/\D/g, "").slice(0, max);
}

const labelCls = "block text-[15px] font-bold text-foreground mb-2";
const inputCls =
  "w-full px-4 py-3.5 border border-border-strong rounded-xl text-[16px] focus:outline-none focus:border-brand-yellow focus:ring-2 focus:ring-brand-yellow/40 bg-white";
const requiredMark = <span className="text-error ml-0.5">*</span>;

interface JobContext {
  id: number;
  title: string;
  branch: string | null;
  client_name: string | null;
  recruiting: boolean;
}

function ApplyForm() {
  const searchParams = useSearchParams();
  const source = normalizeSource(searchParams.get("source"));
  const prefillBranch = searchParams.get("branch");
  const jobParam = searchParams.get("job");
  const jobId = jobParam && /^\d+$/.test(jobParam) ? Number(jobParam) : null;

  const [form, setForm] = useState<FormState>(INITIAL);
  const [branches, setBranches] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [job, setJob] = useState<JobContext | null>(null);

  // 공고 지원 링크(?job=ID)로 들어오면 공고 맥락을 불러와 헤더에 표기하고 지점을 미리 채운다.
  useEffect(() => {
    if (jobId == null) return;
    (async () => {
      try {
        const res = await fetch(`/api/apply/job/${jobId}`);
        if (!res.ok) return;
        const json = await res.json();
        const j = json.job as JobContext;
        setJob(j);
        if (j.branch) setForm((prev) => (prev.branch1 ? prev : { ...prev, branch1: j.branch as string }));
      } catch {
        /* 공고 맥락 없이도 일반 지원 가능 */
      }
    })();
  }, [jobId]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/branches");
        if (!res.ok) return;
        const json = await res.json();
        setBranches((json.branches ?? []) as string[]);
      } catch {
        /* 지점 목록 못 불러와도 직접 입력 가능 */
      }
    })();
  }, []);

  // 공고별 지원 링크(?branch=지점명)로 들어오면 희망 지점 1순위를 미리 채운다.
  useEffect(() => {
    if (prefillBranch) {
      setForm((prev) => (prev.branch1 ? prev : { ...prev, branch1: prefillBranch }));
    }
  }, [prefillBranch]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const toggleWorkHour = (value: string) => {
    setForm((prev) => ({
      ...prev,
      workHours: prev.workHours.includes(value)
        ? prev.workHours.filter((v) => v !== value)
        : [...prev.workHours, value],
    }));
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return "이름을 입력해주세요.";
    if (!/^\d{6}$/.test(form.birthDate)) return "생년월일 6자리(예: 600101)를 입력해주세요.";
    if (!/^\d{10,11}$/.test(form.phone)) return "연락처를 정확히 입력해주세요.";
    if (!form.location.trim()) return "거주지 주소를 입력해주세요.";
    if (!form.ownVehicle) return "자차 보유 여부를 선택해주세요.";
    if (!form.licenseType) return "운전면허 종류를 선택해주세요.";
    if (!form.vehicleType.trim()) return "이동 수단을 입력해주세요.";
    if (!form.branch1) return "희망 지점을 선택해주세요.";
    if (form.workHours.length === 0) return "희망 근무 시간대를 1개 이상 선택해주세요.";
    if (!form.availableDate) return "근무 가능 시작일을 선택해주세요.";
    if (!form.selfOwnership) return "본인 명의 가능 여부를 선택해주세요.";
    return null;
  };

  const handleSubmit = async () => {
    const v = validate();
    if (v) {
      setError(v);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, source, jobId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "제출에 실패했어요. 잠시 후 다시 시도해주세요.");
        return;
      }
      setDone(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setError("제출에 실패했어요. 잠시 후 다시 시도해주세요.");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="bg-white border border-border-strong rounded-3xl p-10 max-w-[480px] w-full text-center shadow-sm">
          <div className="w-16 h-16 rounded-full bg-success-soft flex items-center justify-center mx-auto mb-5">
            <CheckCircle2 size={36} className="text-success" />
          </div>
          <h1 className="text-[24px] font-extrabold text-foreground mb-2">지원이 접수되었어요</h1>
          <p className="text-[15px] text-gray-700 leading-relaxed">
            {form.name}님, 지원서가 정상적으로 접수되었습니다.<br />
            검토 후 문자(SMS)로 안내드릴게요.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background py-10 px-5">
      <div className="max-w-[560px] mx-auto w-full">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 mb-3">
            <LogoMark size={36} />
            <span className="text-[18px] font-extrabold text-foreground">옹고잉 배송원 지원</span>
          </div>
          <p className="text-[15px] text-muted-foreground">아래 항목을 작성해주세요. <span className="text-error">*</span> 표시는 필수입니다.</p>
        </div>

        {job && (
          <div className="mb-6 bg-white border border-border-strong rounded-2xl px-5 py-4 shadow-sm">
            <div className="text-[12px] font-bold text-yellow-700 bg-yellow-50 inline-flex items-center px-2 py-0.5 rounded-full mb-2">지원 공고</div>
            <div className="text-[17px] font-extrabold text-foreground leading-tight">{job.title}</div>
            <div className="text-[13px] text-muted-foreground mt-1">
              {[job.client_name, job.branch].filter(Boolean).join(" · ") || "옹고잉 배송원"}
            </div>
            {!job.recruiting && (
              <div className="mt-2 text-[13px] font-bold text-error-strong bg-error-soft border border-error/30 rounded-lg px-3 py-2">
                현재 마감된 공고예요. 지원서는 접수되며, 다른 공고로 안내드릴 수 있어요.
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mb-6 flex items-start gap-2 bg-error-soft border border-error/30 text-error-strong rounded-xl px-4 py-3 text-[14px] font-bold">
            <AlertCircle size={18} className="shrink-0 mt-0.5" /> {error}
          </div>
        )}

        <div className="bg-white border border-border-strong rounded-2xl p-6 sm:p-8 shadow-sm flex flex-col gap-7">
          {/* 이름 */}
          <div>
            <label className={labelCls}>이름{requiredMark}</label>
            <input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="홍길동" />
          </div>

          {/* 생년월일 */}
          <div>
            <label className={labelCls}>생년월일 (6자리){requiredMark}</label>
            <input className={inputCls} inputMode="numeric" value={form.birthDate} onChange={(e) => set("birthDate", digits(e.target.value, 6))} placeholder="예: 600101" />
          </div>

          {/* 연락처 */}
          <div>
            <label className={labelCls}>연락처{requiredMark}</label>
            <input className={inputCls} inputMode="numeric" value={form.phone} onChange={(e) => set("phone", digits(e.target.value, 11))} placeholder="01012345678" />
          </div>

          {/* 거주지 */}
          <div>
            <label className={labelCls}>거주지 주소{requiredMark}</label>
            <input className={inputCls} value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="예: 서울시 강남구 역삼동" />
          </div>

          {/* 자차 보유 */}
          <div>
            <label className={labelCls}>자차(본인 차량) 보유{requiredMark}</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {["있음", "없음"].map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => set("ownVehicle", opt)}
                  className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background py-3.5 rounded-xl text-[16px] font-bold border-2 transition-all ${form.ownVehicle === opt ? "border-foreground bg-foreground text-white" : "border-border-strong bg-white text-gray-700 hover:border-gray-300"}`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          {/* 운전면허 */}
          <div>
            <label className={labelCls}>운전면허 종류{requiredMark}</label>
            <select className={inputCls} value={form.licenseType} onChange={(e) => set("licenseType", e.target.value)}>
              <option value="">선택해주세요</option>
              {LICENSE_TYPES.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>

          {/* 이동 수단 */}
          <div>
            <label className={labelCls}>이동 수단{requiredMark}</label>
            <input className={inputCls} value={form.vehicleType} onChange={(e) => set("vehicleType", e.target.value)} placeholder="예: 오토바이 / 승용차 / 도보" />
          </div>

          {/* 희망 지점 */}
          <div>
            <label className={labelCls}>희망 지점 (1순위){requiredMark}</label>
            {branches.length > 0 ? (
              <select className={inputCls} value={form.branch1} onChange={(e) => set("branch1", e.target.value)}>
                <option value="">선택해주세요</option>
                {branches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            ) : (
              <input className={inputCls} value={form.branch1} onChange={(e) => set("branch1", e.target.value)} placeholder="희망 지점을 입력해주세요" />
            )}
          </div>

          {/* 희망 지점 2순위 */}
          <div>
            <label className={labelCls}>희망 지점 (2순위, 선택)</label>
            {branches.length > 0 ? (
              <select className={inputCls} value={form.branch2} onChange={(e) => set("branch2", e.target.value)}>
                <option value="">선택 안 함</option>
                {branches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            ) : (
              <input className={inputCls} value={form.branch2} onChange={(e) => set("branch2", e.target.value)} placeholder="(선택)" />
            )}
          </div>

          {/* 희망 근무 시간대 */}
          <div>
            <label className={labelCls}>희망 근무 시간대 (복수 선택){requiredMark}</label>
            <div className="grid grid-cols-1 gap-3">
              {TIMESLOTS.map((slot) => {
                const checked = form.workHours.includes(slot.value);
                return (
                  <button
                    key={slot.value}
                    type="button"
                    onClick={() => toggleWorkHour(slot.value)}
                    className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex items-center justify-between px-4 py-3.5 rounded-xl border-2 text-left transition-all ${checked ? "border-brand-yellow bg-yellow-50" : "border-border-strong bg-white hover:border-gray-300"}`}
                  >
                    <div>
                      <div className="text-[16px] font-bold text-foreground">{slot.label}</div>
                      <div className="text-[13px] text-muted-foreground">{slot.sub}</div>
                    </div>
                    <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center ${checked ? "border-brand-yellow bg-brand-yellow" : "border-gray-300"}`}>
                      {checked && <CheckCircle2 size={16} className="text-foreground" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 근무 가능 시작일 */}
          <div>
            <label className={labelCls}>근무 가능 시작일{requiredMark}</label>
            <input type="date" className={inputCls} value={form.availableDate} onChange={(e) => set("availableDate", e.target.value)} />
          </div>

          {/* 본인 명의 */}
          <div>
            <label className={labelCls}>배달앱·정산계좌 본인 명의 가능 여부{requiredMark}</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {["문제 없음", "문제 있음"].map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => set("selfOwnership", opt)}
                  className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background py-3.5 rounded-xl text-[16px] font-bold border-2 transition-all ${form.selfOwnership === opt ? "border-foreground bg-foreground text-white" : "border-border-strong bg-white text-gray-700 hover:border-gray-300"}`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          {/* 경력 */}
          <div>
            <label className={labelCls}>배달·운전 경력 (선택)</label>
            <textarea className={`${inputCls} min-h-[90px] resize-none`} value={form.experience} onChange={(e) => set("experience", e.target.value)} placeholder="예: 쿠팡이츠 도보 배달 1년" />
          </div>

          {/* 자기소개 */}
          <div>
            <label className={labelCls}>간단한 자기소개 (선택)</label>
            <textarea className={`${inputCls} min-h-[90px] resize-none`} value={form.introduction} onChange={(e) => set("introduction", e.target.value)} placeholder="자유롭게 작성해주세요" />
          </div>

          {/* 마케팅 동의 */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={form.marketingConsent} onChange={(e) => set("marketingConsent", e.target.checked)} className="mt-1 w-5 h-5 accent-brand-yellow" />
            <span className="text-[14px] text-gray-700 leading-relaxed">채용·근무 관련 안내 문자 수신에 동의합니다. (선택)</span>
          </label>
        </div>

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full mt-7 bg-brand-yellow hover:bg-yellow-500 disabled:opacity-60 text-foreground py-4 rounded-xl text-[17px] font-extrabold transition-colors flex items-center justify-center gap-2 shadow-sm"
        >
          {submitting ? <Loader2 size={20} className="animate-spin" /> : null}
          {submitting ? "제출 중…" : "지원서 제출하기"}
        </button>
        <div className="h-10" />
      </div>
    </div>
  );
}

export default function ApplyPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <ApplyForm />
    </Suspense>
  );
}
