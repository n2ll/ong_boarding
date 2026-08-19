"use client";

/**
 * /p/[token] — 무로그인 맞춤 공고 페이지 (pull 채널, PRODUCT_DIRECTION §5.5[3]·§6).
 *
 * 인력풀 지원자가 SMS로 받은 본인 전용 링크. 앱 설치·로그인 없이
 * 지금 모집 중인 공고를 확인하고 '관심 있음'을 남긴다.
 * 관심 표시 = 가능 의사 수집일 뿐 — 배정·확정 뉘앙스 금지(확정은 매니저).
 * 시니어 친화: 큰 글씨·큰 터치 영역·단순 구조.
 */

import { useEffect, useRef, useState } from "react";
import { coarseArea } from "@/lib/geo";
import { POOL_STATUS_DONE_LABEL } from "@/lib/pool-status";
import { useParams } from "next/navigation";
import Image from "next/image";

interface PoolJob {
  id: number;
  title: string;
  body: string | null;
  branch: string | null;
  slot: string | null;
  start_date: string | null;
  vehicle_required: boolean;
  pickup_address: string | null;
  pay_type: string | null;
  pay_amount: number | null;
  pay_info: string | null;
  work_period: string | null;
  closes_at: string | null;
  expired: boolean;
  distance_km: number | null;
  interested: boolean;
  notified: boolean;
  /** 서버 fit 판정 — 'warn'(요건이 확정적으로 어긋남)만 아래 접힌 그룹. 카드는 절대 숨기지 않는다. */
  fit: "ok" | "warn" | "unknown";
  fit_reasons: string[];
  /** 이 공고에서 내가 어디까지 했는지 — 카드 상황 배지(lib/pool-status와 같은 상태 집합). */
  status: "none" | "interested" | "talking" | "paused" | "ended";
}

const PERIOD_LABEL: Record<string, string> = {
  하루: "하루 단기",
  단기: "단기",
  정기: "정기 라인",
};

/** 마감시각 → "7/7(화) 오전 8시 마감" (KST) */
function closesLabel(iso: string): string {
  const kst = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const h = kst.getUTCHours();
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const min = kst.getUTCMinutes();
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()}(${days[kst.getUTCDay()]}) ${ampm} ${h12}시${min ? ` ${min}분` : ""} 마감`;
}

// 금액 병기 대상 단가 유형 — '혼합'/'협의'는 금액을 붙이면 "협의 5,000원"처럼 모순되므로 제외
const AMOUNT_PAY_TYPES = new Set(["건당", "일당", "주급", "월급"]);

function payLabel(j: PoolJob): string | null {
  if (j.pay_type && AMOUNT_PAY_TYPES.has(j.pay_type)) {
    // 금액이 있으면 '건당 3,000원'. 없으면 단위만('건당')은 무의미하므로 pay_info로 폴백,
    // 그것도 없으면 급여 행 자체를 숨긴다(null) — 시니어에게 '급여: 건당' 같은 표기 혼란 방지.
    if (typeof j.pay_amount === "number") {
      return `${j.pay_type} ${j.pay_amount.toLocaleString("ko-KR")}원`;
    }
    return j.pay_info || null;
  }
  if (j.pay_type === "혼합" || j.pay_type === "협의") {
    return j.pay_info || j.pay_type;
  }
  if (j.pay_info) return j.pay_info;
  return null;
}

/** 시작일 → 'YYYY-MM-DD'면 'M월 D일'로, 자유 텍스트면 원문 그대로 */
/** 주소 권역 표기 — '서울 성동구 성수동1가 12-3' → '서울 성동구'. 상세주소는 확정 후 안내에서만 노출. */
function startDateLabel(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return raw;
  return `${Number(m[2])}월 ${Number(m[3])}일`;
}

export default function PoolPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [name, setName] = useState<string | null>(null);
  const [availability, setAvailability] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PoolJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [sendingId, setSendingId] = useState<number | null>(null);
  // 관심 표시 2단계 — 확인 없는 1탭 즉시 접수는 취소가 불가능해서, 같은 자리에서 한 번 더 확인받는다.
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  // 본인 차량 보유(정규화 '있음'|'없음'|'미확인') — 차량이 필요한 공고에 그 사실을 알려주는 데만 쓴다(노출은 그대로).
  const [ownVehicle, setOwnVehicle] = useState<string | null>(null);
  // 갱신 타이머(=[token] 의존 effect)에서 최신 값을 읽기 위한 ref — 확인 중·전송 중 갱신을 건너뛴다.
  const confirmingRef = useRef<number | null>(null);
  const sendingRef = useRef<number | null>(null);
  confirmingRef.current = confirmingId;
  sendingRef.current = sendingId;
  const [doneIds, setDoneIds] = useState<Set<number>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [immediateIds, setImmediateIds] = useState<Set<number>>(new Set());
  const [notifyIds, setNotifyIds] = useState<Set<number>>(new Set());
  // 요건이 다른 자리 접기 — 기본 접힘. 펼치면 그대로 유지(읽는 중 다시 접히면 오클릭).
  const [showOthers, setShowOthers] = useState(false);
  // 이 화면에서 관심을 눌러 띄운 후속 박스('바로 시작 가능?')는 세션 내 유지 —
  // AUTO 모드는 관심 클릭 즉시 AI 문자가 나가 status가 talking으로 바뀌는데, 그때 박스를 치우면
  // 손이 향하던 버튼이 60초 안에 눈앞에서 사라진다. 새 로드에선 비어 있어 '대화 중엔 생략' 규칙 그대로.
  const [followupIds, setFollowupIds] = useState<Set<number>>(new Set());

  const toggleExpanded = (id: number) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // '바로 시작 가능' 후속 버튼 — 관심 표시 이후에만 노출되는 강한 가용성 신호
  const expressImmediate = async (job: PoolJob) => {
    if (sendingId !== null || immediateIds.has(job.id)) return;
    setSendingId(job.id);
    try {
      const res = await fetch(`/api/pool/${token}/interest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id, immediate: true }),
      });
      if (res.ok) {
        setImmediateIds((prev) => new Set(prev).add(job.id));
        setAvailability("즉시가능");
      } else {
        const json = await res.json().catch(() => null);
        alert(json?.error ?? "잠시 후 다시 시도해주세요.");
      }
    } catch {
      alert("잠시 후 다시 시도해주세요.");
    } finally {
      setSendingId(null);
    }
  };

  useEffect(() => {
    if (!token) return;
    // 살아있는 갱신 — 페이지를 열어둔 채여도 새 공고·마감이 반영되게 60초 주기 + 탭 복귀 시 재조회.
    // 백그라운드 갱신은 로딩 화면을 다시 띄우지 않고, 관심/알림 상태는 로컬과 서버의 합집합(낙관적 클릭 보존).
    let cancelled = false;
    const load = (background: boolean) => {
      fetch(`/api/pool/${token}`)
        .then(async (res) => {
          if (cancelled) return;
          if (!res.ok) {
            if (!background) setNotFound(true);
            return;
          }
          const json = await res.json();
          if (cancelled) return;
          setName(json.name ?? null);
          setAvailability(json.availability ?? null);
          setOwnVehicle(json.own_vehicle ?? null);
          // 백그라운드 갱신에서는 카드 목록·순서를 갈아엎지 않는다 —
          // 읽는 중에 순서가 바뀌면 손가락이 내려오는 순간 다른 공고에 관심이 등록된다(시니어 대상 오클릭).
          // 새 공고·마감 반영은 다음 방문(또는 새로고침) 때 이루어진다. 접수 상태는 아래에서 계속 합쳐진다.
          if (background) {
            setJobs((prev) => {
              const incoming: PoolJob[] = json.jobs ?? [];
              if (prev.length === 0) return incoming;
              const byId = new Map(incoming.map((j) => [j.id, j]));
              // 이미 보고 있던 카드는 **위치를 유지**하고 내용만 최신으로(정렬이 바뀌면 오클릭이 난다).
              // 서버에서 사라진 공고는 화면에서도 뺀다 — 남기면 마감된 자리가 계속 '모집 중'으로 보인다.
              // 그룹(맞는 자리 / 접힌 자리)도 **순서의 일부**다 — 읽는 중 카드가 그룹을 넘나들면
              // 열려 있던 확인 패널이 접힌 그룹으로 사라지고, 아래 카드가 위로 당겨져 손가락이
              // 다른 공고의 [관심 있어요]에 떨어진다(이 병합이 막으려던 바로 그 오클릭).
              // fit·fit_reasons는 한 판정이므로 쌍으로 고정한다 — 다음 전체 로드에서 갱신된다.
              const kept = prev
                .filter((j) => byId.has(j.id))
                .map((j) => {
                  const n = byId.get(j.id) as PoolJob;
                  return { ...n, fit: j.fit, fit_reasons: j.fit_reasons };
                });
              // 새로 올라온 공고는 맨 뒤에 붙인다(기존 카드 위치를 밀지 않는다).
              const prevIds = new Set(prev.map((j) => j.id));
              const added = incoming.filter((j) => !prevIds.has(j.id));
              // 확인 패널을 띄운 공고가 사라졌으면 확인 상태도 해제한다.
              if (confirmingRef.current !== null && !byId.has(confirmingRef.current)) setConfirmingId(null);
              // 마감되면 카드 모양 자체가 바뀐다(관심 버튼 없는 '마감됨' 카드) — 확인 패널을 열어둔 채
              // 두면 존재하지 않는 버튼을 기다리며 60초 갱신이 계속 건너뛰어진다.
              if (confirmingRef.current !== null && byId.get(confirmingRef.current)?.expired) setConfirmingId(null);
              return [...kept, ...added];
            });
          } else {
            setJobs(json.jobs ?? []);
          }
          // ended(종료 건)는 접수 상태로 합치지 않는다 — 버튼이 '다시 관심 있어요'로 살아 있어야 한다.
          const serverDone = (json.jobs ?? [])
            .filter((j: PoolJob) => j.interested && j.status !== "ended")
            .map((j: PoolJob) => j.id);
          const serverNotify = (json.jobs ?? []).filter((j: PoolJob) => j.notified).map((j: PoolJob) => j.id);
          // 종료(ended)된 건은 **합집합에서 빼준다** — 안 빼면 세션 중 매니저가 보류·종료해도
          // 낡은 로컬 doneIds가 '접수됐어요 — 매니저가 연락드릴게요'를 유지해, M4가 없애려던
          // 거짓 약속이 열린 화면에서 그대로 되살아난다.
          const serverEnded = new Set<number>(
            (json.jobs ?? []).filter((j: PoolJob) => j.status === "ended").map((j: PoolJob) => j.id)
          );
          setDoneIds((prev) => {
            const merged = new Set([...(background ? prev : []), ...serverDone]);
            for (const id of serverEnded) merged.delete(id);
            return merged;
          });
          setNotifyIds((prev) => new Set([...(background ? prev : []), ...serverNotify]));
        })
        .catch(() => {
          if (!background && !cancelled) setNotFound(true);
        })
        .finally(() => {
          if (!background && !cancelled) setLoading(false);
        });
    };
    load(false);
    const interval = setInterval(() => {
      // 확인 중·전송 중에는 갱신을 건너뛴다(카드가 움직이면 손가락이 다른 버튼에 떨어진다).
      if (confirmingRef.current !== null || sendingRef.current !== null) return;
      load(true);
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token]);

  const expressInterest = async (job: PoolJob) => {
    if (sendingId !== null || doneIds.has(job.id)) return;
    setSendingId(job.id);
    try {
      const res = await fetch(`/api/pool/${token}/interest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id }),
      });
      if (res.ok) {
        setDoneIds((prev) => new Set(prev).add(job.id));
        setFollowupIds((prev) => new Set(prev).add(job.id));
        setConfirmingId(null);
      } else {
        const json = await res.json().catch(() => null);
        alert(json?.error ?? "잠시 후 다시 시도해주세요.");
      }
    } catch {
      alert("잠시 후 다시 시도해주세요.");
    } finally {
      setSendingId(null);
    }
  };

  // 마감된 공고 카드의 "이런 일자리가 또 나오면 먼저 알려주세요" — 놓친 지원자의 가용성 수집
  const expressNotify = async (job: PoolJob) => {
    if (sendingId !== null || notifyIds.has(job.id)) return;
    setSendingId(job.id);
    try {
      const res = await fetch(`/api/pool/${token}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id }),
      });
      if (res.ok) {
        setNotifyIds((prev) => new Set(prev).add(job.id));
      } else {
        const json = await res.json().catch(() => null);
        alert(json?.error ?? "잠시 후 다시 시도해주세요.");
      }
    } catch {
      alert("잠시 후 다시 시도해주세요.");
    } finally {
      setSendingId(null);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3">
          <Image src="/onggoing-logo.png" alt="옹고잉" width={84} height={65} priority />
          <p className="text-[18px] font-bold text-gray-700">공고를 불러오고 있어요…</p>
        </div>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="text-center">
          <Image src="/onggoing-logo.png" alt="옹고잉" width={84} height={65} className="mx-auto mb-3" />
          <p className="text-[20px] font-extrabold text-foreground mb-2">링크를 확인할 수 없어요</p>
          <p className="text-[16px] text-muted-foreground">문자로 받으신 링크 주소를 다시 확인해주세요.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen">
      <div className="max-w-[560px] mx-auto w-full px-5 py-8">
        {/* 빈 상태에서 제목·안내가 바뀐다 — 예전엔 공고 0개여도 "지금 모집 중인 일자리예요 /
            [관심 있어요]를 눌러주세요"가 그대로 떠서, 한 화면이 "일자리가 있다(제목) ·
            없는 버튼을 눌러라(안내) · 없다(카드)"를 동시에 말했다(2026-08-14 감사, 649명 노출). */}
        {(() => {
          const hasOpenJobs = jobs.some((j) => !j.expired);
          return (
            <header className="mb-6">
              <div className="mb-4 flex items-center gap-2.5">
                <Image src="/onggoing-logo.png" alt="옹고잉" width={64} height={50} priority />
                <span aria-hidden="true" className="text-muted-foreground">·</span>
                <span className="text-[14px] font-bold text-warning-strong">맞춤 일자리</span>
              </div>
              <h1 className="text-[24px] font-extrabold text-foreground leading-snug">
                {name ? `${name}님,` : "안녕하세요,"}
                <br />{hasOpenJobs ? "지금 모집 중인 일자리예요" : "지금은 준비된 일자리가 없어요"}
              </h1>
              <p className="mt-2 text-[16px] text-muted-foreground leading-relaxed">
                {hasOpenJobs ? (
                  <>
                    마음에 드는 일자리에 <b className="text-foreground">[관심 있어요]</b>를 눌러주세요.
                    담당 매니저가 확인 후 연락드립니다.
                  </>
                ) : (
                  <>새 일자리가 나오면 이 페이지에 먼저 올라와요. 문자로도 알려드립니다.</>
                )}
              </p>
            </header>
          );
        })()}

        {jobs.filter((j) => !j.expired).length === 0 && (
          <div className="bg-card border border-border-strong rounded-2xl p-6 text-center mb-4 shadow-sm">
            <p className="text-[16px] font-bold text-foreground mb-1">지금은 모집 중인 공고가 없어요</p>
            <p className="text-[14px] text-muted-foreground">새 일자리가 나오면 문자로 알려드릴게요.</p>
          </div>
        )}

        {(() => {
          // 카드 JSX는 그대로 추출만 — 그룹(위/접힘/마감)을 나눠 두 번 이상 쓰기 위한 함수화.
          const renderCard = (job: PoolJob) => {
            // 마감된 공고 — 조용히 사라지는 대신 '다음 기회 알림' 수집 카드로 3일간 노출
            if (job.expired) {
              const notified = notifyIds.has(job.id);
              return (
                <section key={job.id} className="bg-background border border-border-strong rounded-2xl p-5">
                  <span className="inline-block px-2 py-0.5 rounded-full text-[13px] font-extrabold bg-muted text-muted-foreground border border-border-strong">
                    마감됨
                  </span>
                  <h2 className="mt-2 text-[16px] font-extrabold text-muted-foreground leading-snug">{job.title}</h2>
                  {job.interested && (
                    <p className="mt-2 text-[14px] font-bold text-success-strong">
                      ✓ 관심을 접수하셨던 공고예요 — 매니저에게 전달됐어요.
                    </p>
                  )}
                  <p className="mt-2 text-[14px] text-muted-foreground leading-relaxed">
                    이 공고는 마감됐어요. 비슷한 일자리가 나오면 먼저 안내받으실 수 있어요.
                  </p>
                  {notified ? (
                    <p className="mt-3 py-3 text-[16px] font-bold text-success-strong text-center">
                      ✓ 네, 새 일자리가 나오면 먼저 안내드릴게요
                    </p>
                  ) : (
                    <button
                      onClick={() => expressNotify(job)}
                      disabled={sendingId !== null}
                      className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background mt-3 w-full py-3 rounded-2xl text-[16px] font-extrabold bg-card border-2 border-gray-300 text-gray-700 hover:bg-muted active:bg-muted"
                    >
                      {sendingId === job.id ? "접수 중…" : "이런 일자리가 또 나오면 먼저 알려주세요"}
                    </button>
                  )}
                </section>
              );
            }

            // ended(이 공고 건 종료)는 서버 재수화(serverDone)에서 이미 빠진다 — 그래서 doneIds만 보면
            // '다시 관심'을 누른 직후(로컬 클릭)만 접수 상태가 된다. 예전엔 종료 건에도 '연락드릴게요'가
            // 남아 오지 않는 연락을 기다리게 했다.
            const done = doneIds.has(job.id);
            const pay = payLabel(job);
            return (
              <section key={job.id} className="bg-card border border-border-strong rounded-2xl p-5 shadow-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  {/* 상황 배지 — '나 이 자리 어디까지 했더라'를 카드가 먼저 답한다(문구 규칙은 lib/pool-status). */}
                  {job.status === "talking" && (
                    <span className="inline-block px-2 py-0.5 rounded-full text-[13px] font-extrabold bg-success-soft text-success-strong border border-success/25">
                      💬 이야기 중
                    </span>
                  )}
                  {job.status === "paused" && (
                    <span className="inline-block px-2 py-0.5 rounded-full text-[13px] font-extrabold bg-info-soft text-info-strong border border-info/25">
                      매니저 확인 중
                    </span>
                  )}
                  {job.work_period && (
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[13px] font-extrabold ${
                        job.work_period === "정기"
                          ? "bg-success-soft text-success-strong border border-success/25"
                          : "bg-yellow-50 text-warning-strong border border-yellow-200"
                      }`}
                    >
                      {PERIOD_LABEL[job.work_period] ?? job.work_period}
                    </span>
                  )}
                  {job.closes_at && (
                    <span className="inline-block px-2 py-0.5 rounded-full text-[13px] font-extrabold bg-error-soft text-error-strong border border-error-soft">
                      ⏰ {closesLabel(job.closes_at)}
                    </span>
                  )}
                </div>
                {/* 제목의 끝 '(…원)'은 아래 급여 행과 중복이라 표시에서 제거(불필요한 글자↓).
                    '(7/23~8/24)' 같은 날짜 괄호는 원으로 안 끝나 유지된다. */}
                <h2 className="mt-2 text-[20px] font-extrabold text-foreground leading-snug">
                  {job.title.replace(/\s*\([^)]*원\)\s*$/, "")}
                </h2>
                <dl className="mt-3 flex flex-col gap-1.5 text-[16px] text-gray-700">
                  {pay && (
                    <div className="flex gap-2">
                      <dt className="w-[72px] shrink-0 font-bold text-muted-foreground">급여</dt>
                      <dd className="font-bold text-foreground">{pay} <span className="font-medium text-[13px] text-muted-foreground">(변동될 수 있어요)</span></dd>
                    </div>
                  )}
                  {(job.branch || job.pickup_address) && (
                    <div className="flex gap-2">
                      <dt className="w-[72px] shrink-0 font-bold text-muted-foreground">{job.branch ? "지점" : "출발지"}</dt>
                      {/* 지점명이 없으면 집결지 주소로 대신 보여주되 **권역까지만** — 상세주소(동/번지 뒤)는
                          확정 후 만남장소 안내에서 알려준다. 링크만 있으면 누구나 보는 화면이다. */}
                      <dd className="break-words">{job.branch || coarseArea(job.pickup_address)}</dd>
                    </div>
                  )}
                  {job.distance_km !== null && (
                    <div className="flex gap-2">
                      <dt className="w-[72px] shrink-0 font-bold text-muted-foreground">거리</dt>
                      <dd className="font-bold text-success">집에서 약 {job.distance_km}km</dd>
                    </div>
                  )}
                  {job.slot && (
                    <div className="flex gap-2">
                      <dt className="w-[72px] shrink-0 font-bold text-muted-foreground">근무시간</dt>
                      <dd>{job.slot}</dd>
                    </div>
                  )}
                  {job.start_date && (
                    <div className="flex gap-2">
                      <dt className="w-[72px] shrink-0 font-bold text-muted-foreground">시작일</dt>
                      <dd>{startDateLabel(job.start_date)}</dd>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <dt className="w-[72px] shrink-0 font-bold text-muted-foreground">차량</dt>
                    <dd>{job.vehicle_required ? "본인 차량 필요" : "차량 없어도 가능"}</dd>
                  </div>
                  {/* 요건이 어긋난 이유 — 서버 fit 판정(lib/pool-fit)의 문장을 그대로 보여준다(판정 한 곳).
                      카드를 감추지는 않는다 — 차량이 새로 생겼을 수 있고, 판단은 지원자 몫. */}
                  {job.fit_reasons.length > 0 && (
                    <div className="mt-1 rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2 text-[14px] font-bold text-warning-strong leading-snug">
                      {job.fit_reasons.map((r, i) => (
                        <p key={i}>{r}</p>
                      ))}
                      <p className="mt-1 font-semibold text-warning-strong">
                        {done ? "매니저가 연락드릴 때 함께 확인할게요." : "그래도 괜찮으시면 관심을 눌러 주세요."}
                      </p>
                    </div>
                  )}
                </dl>

                {job.body && (
                  <div className="mt-3 border-t border-muted pt-2">
                    {/* 본문은 기본 접힘 — 위 요약(급여·시작일·차량)이 스캔 단위. 프로즈가 요약과 겹쳐
                        기본 노출하면 글자만 많아지고 3개 비교가 어렵다. 원하는 사람만 펼쳐 본다. */}
                    {expandedIds.has(job.id) && (
                      <div className="mt-1 text-[16px] text-gray-700 leading-relaxed">
                        {/* 업무 관련 주요 내용(■ 항목 = 운임·요일·시간·차량 등)은 볼드로 강조 */}
                        {job.body.split("\n").map((line, i) => (
                          <p
                            key={i}
                            className={line.trimStart().startsWith("■") ? "font-bold text-foreground" : ""}
                          >
                            {line || " "}
                          </p>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => toggleExpanded(job.id)}
                      className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background py-2.5 mb-2 text-[16px] font-bold text-warning-strong"
                    >
                      {expandedIds.has(job.id) ? "접기 ▲" : "자세한 공고 내용 보기 ▼"}
                    </button>
                  </div>
                )}

                {done || confirmingId !== job.id ? (
                  <button
                    onClick={() => {
                      if (done) return;
                      // 전송 중에는 다른 카드 버튼도 눌리지 않는다(예전엔 눌러도 아무 반응이 없어 고장으로 보였다).
                      if (sendingId !== null) return;
                      setConfirmingId(job.id);
                    }}
                    disabled={done || sendingId !== null}
                    className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background mt-5 w-full py-5 rounded-2xl text-[18px] font-extrabold transition-colors ${
                      done
                        ? "bg-success-soft text-success-strong border border-success-soft"
                        : sendingId !== null
                          ? "bg-muted text-muted-foreground"
                          : "bg-brand-yellow text-foreground shadow-brand hover:bg-yellow-500 active:bg-yellow-500"
                    } disabled:cursor-default`}
                  >
                    {done
                      ? job.status === "talking"
                        ? POOL_STATUS_DONE_LABEL.talking
                        : job.status === "paused"
                          ? POOL_STATUS_DONE_LABEL.paused
                          : POOL_STATUS_DONE_LABEL.interested
                      : sendingId !== null
                        ? "잠시만요…"
                        : job.status === "ended"
                          ? "다시 관심 있어요"
                          : "관심 있어요"}
                  </button>
                ) : (
                  // 두 번째 단계 — 어느 공고인지 다시 보여주고 확인받는다. 잘못 눌렀으면 여기서 되돌린다.
                  <div className="mt-5 rounded-2xl border-2 border-brand-yellow bg-yellow-50 p-3">
                    <p className="text-[16px] font-bold text-foreground text-center leading-snug">
                      <span className="text-warning-strong">{job.title}</span>
                      <br />이 일자리에 관심 있다고 보낼까요?
                    </p>
                    {job.vehicle_required && ownVehicle === "없음" && (
                      <p className="mt-2 text-[14px] font-bold text-warning-strong text-center leading-snug">
                        본인 차량이 필요한 자리예요 — 괜찮으신가요?
                      </p>
                    )}
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => setConfirmingId(null)}
                        disabled={sendingId !== null}
                        className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex-1 py-4 rounded-2xl text-[16px] font-extrabold bg-white text-gray-700 border border-gray-300"
                      >
                        아니요
                      </button>
                      <button
                        onClick={() => expressInterest(job)}
                        disabled={sendingId !== null}
                        className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex-[1.4] py-4 rounded-2xl text-[16px] font-extrabold bg-brand-yellow text-foreground active:bg-yellow-500 disabled:opacity-70"
                      >
                        {sendingId === job.id ? "보내는 중…" : "네, 보낼게요"}
                      </button>
                    </div>
                  </div>
                )}

                {done && (followupIds.has(job.id) || (job.status !== "talking" && job.status !== "paused")) && (
                  <div className="mt-3 rounded-2xl bg-yellow-50 border border-yellow-200 p-3">
                    {/* 이미 '즉시가능' 상태면(이번 클릭이든 과거 응답이든) 질문을 다시 하지 않는다 —
                        새로고침 시 서버의 availability로 재수화 (중복 클릭 방지) */}
                    {immediateIds.has(job.id) || availability === "즉시가능" ? (
                      <p className="text-[16px] font-bold text-success text-center">
                        ⚡ 바로 시작 가능 — 확인했어요! 매니저가 참고할게요
                      </p>
                    ) : (
                      <>
                        <p className="text-[16px] font-bold text-gray-700 text-center mb-2">
                          혹시 시작일에 바로 시작도 가능하세요?
                        </p>
                        <button
                          onClick={() => expressImmediate(job)}
                          disabled={sendingId !== null}
                          className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full py-3 rounded-2xl text-[16px] font-extrabold bg-white border-2 border-brand-yellow text-foreground hover:bg-yellow-50 active:bg-yellow-50"
                        >
                          {sendingId === job.id ? "확인 중…" : "네, 바로도 가능해요"}
                        </button>
                      </>
                    )}
                  </div>
                )}

                {job.closes_at && (
                  <p className="mt-3 text-[13px] text-muted-foreground text-center leading-relaxed">
                    마감시각이 지나면 새 지원은 받을 수 없어요.
                    <br />먼저 관심 주신 분부터 매니저가 연락드립니다.
                  </p>
                )}
              </section>
            );
          };
          // 서버가 정한 순서를 그대로 따른다(재정렬 금지) — 여기서는 그룹으로 나누기만 한다.
          //
          // ⚠️ **이미 시작된 자리는 접지 않는다.** 관심을 눌렀거나 이야기 중인 카드가 요건 불일치로
          // 기본 접힘 뒤에 숨으면, M1b가 세운 '이야기 중인 공고가 본인 화면에서 사라지면 안 된다'는
          // 불변식이 시각적으로 되돌아간다(AI만 그 공고를 말하는 상태와 같은 체감). 접기는 **아직
          // 손대지 않은 자리**를 정리하는 장치일 뿐이다.
          const isFolded = (j: PoolJob) => j.fit === "warn" && j.status === "none";
          const activeMain = jobs.filter((j) => !j.expired && !isFolded(j));
          const activeOthers = jobs.filter((j) => !j.expired && isFolded(j));
          const expiredJobs = jobs.filter((j) => j.expired);
          // 활성 카드가 전부 접히면 위 영역이 **카드 0장**이 된다 — 헤더는 "[관심 있어요]를 눌러주세요"라고
          // 하는데 그 버튼이 화면에 없고, 빈 상태 안내도 뜨지 않는다(활성 공고는 있으니까).
          // 실측: 실공고 6개가 전부 차량 필수라 차량 없는 165명이 정확히 이 상태였다. 그때는 자동으로 펼친다.
          const forceShowOthers = activeMain.length === 0 && activeOthers.length > 0;
          return (
            <div className="flex flex-col gap-4">
              {activeMain.map(renderCard)}
              {activeOthers.length > 0 && (
                <section>
                  {/* 요건이 어긋난 자리는 접어두되 **숨기지 않는다** — 차량이 새로 생겼을 수 있고 판단은 지원자 몫. */}
                  {forceShowOthers ? (
                    // 전부 접힐 상황 — 안내 한 줄을 주고 카드를 그대로 보여준다(빈 화면 금지).
                    <div className="rounded-2xl bg-card border border-border-strong p-4 mb-4">
                      <p className="text-[16px] font-bold text-foreground leading-snug">
                        지금 올라온 자리는 등록해 주신 정보와 조건이 좀 달라요
                      </p>
                      <p className="mt-1 text-[14px] text-muted-foreground leading-relaxed">
                        그래도 괜찮으시면 관심을 눌러 주세요 — 매니저가 확인 후 연락드립니다.
                      </p>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowOthers((v) => !v)}
                      className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full py-4 rounded-2xl text-[16px] font-extrabold bg-card border-2 border-dashed border-gray-300 text-muted-foreground hover:bg-background active:bg-background"
                    >
                      {showOthers
                        ? "조건이 다른 자리 접기 ▲"
                        : `조건이 다를 수 있는 자리 ${activeOthers.length}개 더 보기 ▼`}
                    </button>
                  )}
                  {(showOthers || forceShowOthers) && (
                    <div className="mt-4 flex flex-col gap-4">{activeOthers.map(renderCard)}</div>
                  )}
                </section>
              )}
              {expiredJobs.map(renderCard)}
            </div>
          );
        })()}

        <footer className="mt-10 border-t border-border-strong pt-6 pb-2 text-center">
          <div className="mb-2.5 flex items-center justify-center">
            <Image src="/onggoing-logo.png" alt="옹고잉" width={52} height={40} />
          </div>
          <p className="text-[14px] font-bold text-gray-700 leading-relaxed">
            궁금한 점은 받으신 문자에 답장해 주세요.
            <br />매니저가 직접 확인하고 답해드립니다.
          </p>
          <p className="mt-3 text-[13px] text-muted-foreground leading-relaxed">
            이 페이지는 본인 전용 링크예요. 다른 분과 공유하지 말아주세요.
            <br />관심 표시는 지원 의사 확인이며, 근무 확정은 매니저 안내 후 진행됩니다.
          </p>
        </footer>
      </div>
    </main>
  );
}
