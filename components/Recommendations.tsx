import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  AlertCircle,
  BriefcaseBusiness,
  CarFront,
  CheckCircle2,
  Clock3,
  Info,
  ListChecks,
  MapPin,
  RefreshCw,
  UserRound,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { ApplicantDetailPanel } from "./ApplicantDetailPanel";
import { Button, buttonVariants } from "./ui/button";
import { PageShell } from "./ui/page-shell";
import {
  recommendationAddOutcome,
  recommendationEvidence,
  recommendationJobsView,
  recommendationResultView,
  recommendationVehicleFit,
} from "@/lib/admin/recommendation-view";

interface ApiJob {
  id: number;
  title: string;
  body: string;
  branch: string | null;
  pickup_address: string | null;
  vehicle_required: boolean;
  status: string;
  counts: Record<string, number>;
}

interface ScoredCand {
  id: number;
  source: "applicant" | "legacy";
  name: string;
  phone: string;
  location: string | null;
  sigungu: string | null;
  own_vehicle: string | null;
  created_at?: string | null;
  recency_at?: string | null;
  score: {
    total: number;
    distance: number;
    vehicle: number;
    recency: number;
    distanceKm: number;
  };
}

type CandidateAction = {
  state: "adding" | "added" | "already_added" | "error" | "partial_error";
  message?: string;
};

const activityDateFormatter = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function Recommendations() {
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [recs, setRecs] = useState<ScoredCand[]>([]);
  const [poolSize, setPoolSize] = useState(0);
  const [loading, setLoading] = useState(false);
  const [requested, setRequested] = useState(false);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [candidateActions, setCandidateActions] = useState<Record<number, CandidateAction>>({});

  // 공고 목록은 Jobs 탭과 같은 SWR 키를 사용해 탭 이동 시 중복 요청을 줄인다.
  const {
    data: jobsApi,
    error: jobsError,
    isValidating: jobsValidating,
    mutate: mutateJobs,
  } = useSWR<{ jobs?: ApiJob[] }>("/api/admin/jobs?status=all");
  const jobs = useMemo(
    () => (jobsApi?.jobs ?? []).filter((job) => job.status !== "closed" && !job.title.startsWith("__")),
    [jobsApi],
  );
  const jobsView = recommendationJobsView({
    jobs: jobsApi ? jobs : undefined,
    error: jobsError,
  });

  // 첫 진입이나 공고 마감으로 현재 선택이 사라졌을 때만 첫 공고로 이동한다.
  useEffect(() => {
    if (jobs.length > 0 && (selectedJobId === null || !jobs.some((job) => job.id === selectedJobId))) {
      setSelectedJobId(jobs[0].id);
      setRecs([]);
      setPoolSize(0);
      setRequested(false);
      setRecommendationError(null);
      setCandidateActions({});
    }
  }, [jobs, selectedJobId]);

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;
  const resultView = recommendationResultView({
    requested,
    loading,
    error: recommendationError,
    candidates: recs,
  });

  const handleSelect = (id: number) => {
    if (id === selectedJobId) return;
    setSelectedJobId(id);
    setRecs([]);
    setPoolSize(0);
    setRequested(false);
    setRecommendationError(null);
    setCandidateActions({});
  };

  const handleGenerate = async () => {
    if (!selectedJob || loading || jobsView.state !== "ready") return;
    setRequested(true);
    setLoading(true);
    setRecommendationError(null);
    setRecs([]);
    setPoolSize(0);
    try {
      const res = await fetch("/api/admin/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          posting: selectedJob.body || selectedJob.title,
          manualAddress: selectedJob.pickup_address || undefined,
          manualVehicleRequired: selectedJob.vehicle_required,
          topN: 10,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = typeof json.error === "string" ? json.error : "추천 계산에 실패했어요.";
        setRecommendationError(message);
        toast.error(message);
        return;
      }
      const candidates = Array.isArray(json.candidates) ? json.candidates as ScoredCand[] : [];
      setRecs(candidates);
      setPoolSize(typeof json.poolSize === "number" ? json.poolSize : 0);
    } catch {
      const message = "추천 서버에 연결하지 못했어요.";
      setRecommendationError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  // 후보 풀 추가만 수행한다. 문자 발송·근무 배정·근무 확정은 이 액션에 포함되지 않는다.
  const handleAddCandidate = async (rec: ScoredCand) => {
    if (!selectedJobId || rec.source !== "applicant") return;
    setCandidateActions((current) => ({ ...current, [rec.id]: { state: "adding" } }));
    try {
      const res = await fetch(`/api/admin/jobs/${selectedJobId}/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_ids: [rec.id] }),
      });
      const json = await res.json().catch(() => ({}));
      const outcome = recommendationAddOutcome({
        ok: res.ok,
        added: json.added,
        error: json.error,
        partial: json.partial,
      });

      if (outcome === "error" || outcome === "partial_error") {
        const message = typeof json.error === "string" ? json.error : "후보 추가에 실패했어요.";
        setCandidateActions((current) => ({ ...current, [rec.id]: { state: outcome, message } }));
        toast.error(message);
        return;
      }

      setCandidateActions((current) => ({ ...current, [rec.id]: { state: outcome } }));
      if (outcome === "already_added") {
        toast.info(`${rec.name}님은 이미 이 공고의 후보예요.`);
      } else {
        toast.success(`${rec.name}님을 공고 후보로 추가했어요. 근무 배정이나 확정은 별도입니다.`);
      }
    } catch {
      const message = "후보 추가 서버에 연결하지 못했어요.";
      setCandidateActions((current) => ({ ...current, [rec.id]: { state: "error", message } }));
      toast.error(message);
    }
  };

  return (
    <PageShell className="mx-auto w-full max-w-[1440px]">
      <h1 className="sr-only">AI 인재 추천</h1>

      <section aria-labelledby="recommendations-title" className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <p className="mb-1 text-[12px] font-extrabold uppercase tracking-[0.12em] text-warning-strong">인재풀 매칭</p>
          <h2 id="recommendations-title" className="text-xl font-extrabold tracking-tight text-foreground sm:text-2xl">
            공고별 추천 후보 검토
          </h2>
          <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
            생성형 AI의 판단이 아니라 거리·차량·최근 활동일을 합산한 규칙 점수입니다. 점수와 원본 근거를 함께 확인하세요.
          </p>
        </div>
        <div className="rounded-2xl border border-border-strong bg-card px-4 py-3 shadow-xs" aria-label="추천 점수 배점">
          <div className="flex items-center gap-2 text-[13px] font-extrabold text-foreground">
            <ListChecks aria-hidden="true" className="size-4 text-warning-strong" /> 규칙 점수 100점
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">거리 70 · 차량 20 · 최신성 10</p>
        </div>
      </section>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[17rem_minmax(0,1fr)] xl:gap-6">
        <aside aria-labelledby="jobs-heading" className="rounded-2xl border border-border-strong bg-card p-4 shadow-sm lg:sticky lg:top-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h2 id="jobs-heading" className="text-[14px] font-extrabold text-foreground">진행 공고</h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">추천 기준이 될 공고를 선택하세요.</p>
            </div>
            {jobsView.state === "ready" && (
              <span className="rounded-full bg-muted px-2 py-1 text-[12px] font-bold text-muted-foreground">{jobsView.count}건</span>
            )}
          </div>

          {jobsView.state === "loading" && (
            <div role="status" aria-label="공고 목록 불러오는 중" className="space-y-2">
              {[0, 1, 2].map((item) => (
                <div key={item} className="h-[68px] animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />
              ))}
            </div>
          )}

          {jobsView.state === "error" && (
            <div role="alert" className="rounded-2xl border border-error/30 bg-error-soft p-4 text-[13px] text-error-strong">
              <div className="flex items-start gap-2 font-bold">
                <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                공고를 불러오지 못했어요. 0건으로 처리하지 않았습니다.
              </div>
              <Button variant="secondary" size="sm" className="mt-3 w-full" onClick={() => void mutateJobs()} isLoading={jobsValidating}>
                <RefreshCw aria-hidden="true" /> 다시 시도
              </Button>
            </div>
          )}

          {jobsView.state === "empty" && (
            <div className="rounded-2xl border border-dashed border-border-strong p-4 text-center">
              <BriefcaseBusiness aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
              <p className="mt-2 text-[13px] font-bold text-foreground">추천할 진행 공고가 없어요.</p>
              <Link
                href="/jobs"
                className={buttonVariants({ variant: "secondary", size: "sm", className: "mt-3 w-full" })}
              >
                공고 관리로 이동
              </Link>
            </div>
          )}

          {jobsView.state === "ready" && (
            <ul aria-label="추천 대상 공고" className="space-y-2">
              {jobs.map((job) => {
                const total = Object.values(job.counts || {}).reduce((sum, count) => sum + count, 0);
                const selected = selectedJobId === job.id;
                return (
                  <li key={job.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      title={job.title}
                      onClick={() => handleSelect(job.id)}
                      className={`min-h-[68px] w-full cursor-pointer rounded-2xl border px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${selected ? "border-foreground bg-brand-muted shadow-xs" : "border-transparent bg-background hover:border-border-strong hover:bg-muted active:bg-accent"}`}
                    >
                      <span className="block text-[13px] font-extrabold leading-snug text-foreground">{job.title}</span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
                        <span>후보 {total}명</span>
                        <span aria-hidden="true">·</span>
                        <span>{job.branch || "지점 미지정"}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="min-w-0 space-y-4" aria-labelledby="results-heading">
          <section className="rounded-2xl border border-border-strong bg-card p-4 shadow-sm sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <h2 id="results-heading" title={selectedJob?.title} className="truncate text-[16px] font-extrabold text-foreground">
                  {selectedJob?.title ?? "추천할 공고를 선택하세요"}
                </h2>
                {selectedJob && (
                  <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
                    <span className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-background px-2.5 py-1 font-bold text-muted-foreground">
                      <MapPin aria-hidden="true" className="size-3.5" /> {selectedJob.pickup_address ? "상차지 기준" : "공고 주소 추출 필요"}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-background px-2.5 py-1 font-bold text-muted-foreground">
                      <CarFront aria-hidden="true" className="size-3.5" /> 차량 {selectedJob.vehicle_required ? "필수" : "필수 아님"}
                    </span>
                  </div>
                )}
              </div>
              <Button variant="brand" onClick={handleGenerate} disabled={!selectedJob || jobsView.state !== "ready"} isLoading={loading}>
                <ListChecks aria-hidden="true" /> {requested ? "추천 다시 계산" : "추천 계산"}
              </Button>
            </div>

            <div className="mt-4 flex items-start gap-2 rounded-2xl bg-background px-3.5 py-3 text-[12px] leading-relaxed text-muted-foreground">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info-strong" />
              <p>
                차량 필수 공고는 보유 여부를 점수화하고, 필수 아님이면 모든 후보에 같은 기본점을 적용합니다. 최근성은 최근 활동일의 30·90·180일 구간입니다.
              </p>
            </div>
          </section>

          {resultView === "idle" && (
            <section className="rounded-2xl border border-dashed border-border-strong bg-card px-6 py-10 text-center">
              <Users aria-hidden="true" className="mx-auto size-7 text-muted-foreground" />
              <p className="mt-3 text-[14px] font-extrabold text-foreground">아직 계산한 추천이 없어요.</p>
              <p className="mt-1 text-[13px] text-muted-foreground">공고를 선택한 뒤 추천 계산을 실행하세요.</p>
            </section>
          )}

          {resultView === "loading" && (
            <section role="status" aria-label="추천 후보 계산 중" className="space-y-3">
              {[0, 1, 2].map((item) => (
                <div key={item} className="h-[188px] animate-pulse rounded-2xl border border-border bg-card motion-reduce:animate-none" />
              ))}
            </section>
          )}

          {resultView === "error" && (
            <section role="alert" className="rounded-2xl border border-error/30 bg-error-soft p-5 text-error-strong">
              <div className="flex items-start gap-2">
                <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                <div>
                  <h3 className="text-[14px] font-extrabold">추천 계산에 실패했어요.</h3>
                  <p className="mt-1 text-[13px] leading-relaxed">{recommendationError}</p>
                </div>
              </div>
              <Button variant="secondary" size="sm" className="mt-4" onClick={handleGenerate}>
                <RefreshCw aria-hidden="true" /> 다시 계산
              </Button>
            </section>
          )}

          {resultView === "empty" && (
            <section className="rounded-2xl border border-dashed border-border-strong bg-card px-6 py-10 text-center">
              <UserRound aria-hidden="true" className="mx-auto size-7 text-muted-foreground" />
              <p className="mt-3 text-[14px] font-extrabold text-foreground">계산 대상이 되는 후보가 없어요.</p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                추천 대상 중 좌표가 있는 인재가 없습니다. 공고 주소와 인재 위치 정보를 확인하세요.
              </p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={handleGenerate}>
                <RefreshCw aria-hidden="true" /> 다시 계산
              </Button>
            </section>
          )}

          {resultView === "ready" && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 px-1" aria-live="polite">
                <p className="text-[13px] font-bold text-foreground">상위 {recs.length}명</p>
                <p className="text-[12px] text-muted-foreground">좌표가 있는 추천 대상 {poolSize.toLocaleString()}명 기준</p>
              </div>

              <div className="rounded-2xl border border-info/20 bg-info-soft px-4 py-3 text-[12px] leading-relaxed text-info-strong">
                <strong>공고 후보 추가는 검토 목록에 넣는 단계입니다.</strong> 문자 발송, 근무 배정, 근무 확정은 자동으로 이루어지지 않습니다.
              </div>

              <ol className="space-y-3" aria-label="추천 후보 목록">
                {recs.map((rec, index) => {
                  const evidence = recommendationEvidence({
                    ownVehicle: rec.own_vehicle,
                    recencyAt: rec.recency_at,
                    createdAt: rec.created_at,
                    score: rec.score,
                  });
                  const action = candidateActions[rec.id];
                  const actionDone = action?.state === "added" || action?.state === "already_added";
                  const actionError = action?.state === "error" || action?.state === "partial_error";
                  const vehicleFit = recommendationVehicleFit(evidence.vehicle, selectedJob?.vehicle_required ?? false);
                  const activityLabel = evidence.activityAt
                    ? activityDateFormatter.format(new Date(evidence.activityAt))
                    : "활동일 정보 없음";

                  return (
                    <li key={`${rec.source}-${rec.id}`} className="rounded-2xl border border-border-strong bg-card p-4 shadow-sm sm:p-5">
                      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_11.5rem]">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-3">
                              <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-foreground text-[13px] font-extrabold text-white">
                                {index + 1}
                              </span>
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h3 title={rec.name || undefined} className="truncate text-[16px] font-extrabold text-foreground">{rec.name || "이름 정보 없음"}</h3>
                                  {rec.source === "legacy" && (
                                    <span className="rounded-full border border-warning/30 bg-warning-soft px-2 py-0.5 text-[12px] font-bold text-warning-strong">레거시</span>
                                  )}
                                </div>
                                <p className="mt-1 text-[12px] text-muted-foreground">{rec.sigungu || rec.location || "거주지 정보 없음"}</p>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="text-[12px] font-bold text-muted-foreground">규칙 점수</p>
                              <p className="text-xl font-black tabular-nums text-foreground">
                                {evidence.total === null ? "—" : Math.round(evidence.total)}<span className="ml-0.5 text-[12px] font-bold text-muted-foreground">/100</span>
                              </p>
                            </div>
                          </div>

                          <dl className="mt-4 grid gap-2 sm:grid-cols-3">
                            <div className="rounded-2xl border border-border bg-background p-3">
                              <dt className="flex items-center gap-1.5 text-[12px] font-bold text-muted-foreground"><MapPin aria-hidden="true" className="size-3.5" /> 거리</dt>
                              <dd className="mt-1 text-[13px] font-extrabold text-foreground">{evidence.distanceKm === null ? "정보 없음" : `${evidence.distanceKm.toFixed(1)}km`}</dd>
                              <dd className="mt-0.5 text-[12px] text-muted-foreground">{evidence.distancePoints === null ? "배점 —" : `${evidence.distancePoints}/70점`}</dd>
                            </div>
                            <div className="rounded-2xl border border-border bg-background p-3">
                              <dt className="flex items-center gap-1.5 text-[12px] font-bold text-muted-foreground"><CarFront aria-hidden="true" className="size-3.5" /> 차량</dt>
                              <dd className="mt-1 text-[13px] font-extrabold text-foreground">
                                {evidence.vehicle === "owned" ? "자차 보유" : evidence.vehicle === "not_owned" ? "자차 없음" : "정보 없음"}
                              </dd>
                              <dd className={`mt-0.5 text-[12px] ${vehicleFit === "does_not_meet" || vehicleFit === "needs_review" ? "font-bold text-warning-strong" : "text-muted-foreground"}`}>
                                {vehicleFit === "does_not_meet" ? "필수 조건 미충족" : vehicleFit === "needs_review" ? "필수 조건 확인 필요" : vehicleFit === "meets" ? "필수 조건 충족" : "필수 조건 아님"}
                              </dd>
                              <dd className="mt-0.5 text-[12px] text-muted-foreground">{evidence.vehiclePoints === null ? "배점 —" : `${evidence.vehiclePoints}/20점`}</dd>
                            </div>
                            <div className="rounded-2xl border border-border bg-background p-3">
                              <dt className="flex items-center gap-1.5 text-[12px] font-bold text-muted-foreground"><Clock3 aria-hidden="true" className="size-3.5" /> 최근 활동</dt>
                              <dd className="mt-1 text-[13px] font-extrabold text-foreground">{activityLabel}</dd>
                              <dd className="mt-0.5 text-[12px] text-muted-foreground">{evidence.recencyPoints === null ? "배점 —" : `${evidence.recencyPoints}/10점`}</dd>
                            </div>
                          </dl>
                        </div>

                        <div className="flex flex-col justify-center gap-2 border-t border-border pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
                          {rec.source === "applicant" ? (
                            <>
                              <Button
                                variant="primary"
                                size="sm"
                                className="w-full"
                                onClick={() => void handleAddCandidate(rec)}
                                disabled={actionDone}
                                isLoading={action?.state === "adding"}
                              >
                                {actionDone ? <CheckCircle2 aria-hidden="true" /> : <Users aria-hidden="true" />}
                                {action?.state === "added" ? "후보로 추가됨" : action?.state === "already_added" ? "이미 후보임" : actionError ? "다시 시도" : "공고 후보로 추가"}
                              </Button>
                              <Button variant="secondary" size="sm" className="w-full" onClick={() => setProfileId(rec.id)}>
                                <UserRound aria-hidden="true" /> 프로필 보기
                              </Button>
                              {actionError && (
                                <p role="alert" className="rounded-xl bg-error-soft px-2.5 py-2 text-[12px] leading-relaxed text-error-strong">
                                  {action?.state === "partial_error" ? "후보는 추가됐지만 노출 명단 연결에 실패했을 수 있어요. " : ""}{action.message}
                                </p>
                              )}
                              {actionDone && (
                                <p role="status" className="text-center text-[12px] font-bold text-success-strong">배정·확정되지 않음</p>
                              )}
                            </>
                          ) : (
                            <div className="rounded-2xl border border-dashed border-warning/40 bg-warning-soft p-3 text-[12px] leading-relaxed text-warning-strong">
                              <strong className="block">이 화면에서 추가할 수 없음</strong>
                              옹보딩 지원자 ID가 없는 외부 기록입니다. 원본 인력풀에서 정보를 확인하세요.
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </section>
      </div>

      <ApplicantDetailPanel
        isOpen={profileId !== null}
        onClose={() => setProfileId(null)}
        applicantId={profileId}
        jobId={selectedJobId}
      />
    </PageShell>
  );
}
