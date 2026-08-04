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
import { POOL_STATUS_DONE_LABEL } from "@/lib/pool-status";
import { useParams } from "next/navigation";

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
function shortArea(addr: string | null): string {
  const t = (addr ?? "").trim().split(/\s+/).filter(Boolean);
  if (t.length === 0) return "";
  return t.slice(0, 2).join(" ");
}

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
              const kept = prev.filter((j) => byId.has(j.id)).map((j) => byId.get(j.id) as PoolJob);
              // 새로 올라온 공고는 맨 뒤에 붙인다(기존 카드 위치를 밀지 않는다).
              const prevIds = new Set(prev.map((j) => j.id));
              const added = incoming.filter((j) => !prevIds.has(j.id));
              // 확인 패널을 띄운 공고가 사라졌으면 확인 상태도 해제한다.
              if (confirmingRef.current !== null && !byId.has(confirmingRef.current)) setConfirmingId(null);
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
          setDoneIds((prev) => new Set([...(background ? prev : []), ...serverDone]));
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
      <main className="min-h-screen bg-[#FFFBEC] flex items-center justify-center p-6">
        <p className="text-[18px] font-bold text-[#4A5568]">공고를 불러오고 있어요…</p>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className="min-h-screen bg-[#FFFBEC] flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-[20px] font-extrabold text-[#1A202C] mb-2">링크를 확인할 수 없어요</p>
          <p className="text-[15px] text-[#718096]">문자로 받으신 링크 주소를 다시 확인해주세요.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#FFFBEC]">
      <div className="max-w-[560px] mx-auto px-5 py-8">
        <header className="mb-6">
          <div className="text-[14px] font-bold text-[#B7791F] mb-1">옹고잉 · 맞춤 일자리</div>
          <h1 className="text-[24px] font-extrabold text-[#1A202C] leading-snug">
            {name ? `${name}님,` : "안녕하세요,"}
            <br />지금 모집 중인 일자리예요
          </h1>
          <p className="mt-2 text-[15px] text-[#718096] leading-relaxed">
            마음에 드는 일자리에 <b className="text-[#1A202C]">[관심 있어요]</b>를 눌러주세요.
            담당 매니저가 확인 후 연락드립니다.
          </p>
        </header>

        {jobs.filter((j) => !j.expired).length === 0 && (
          <div className="bg-white border border-[#E2E8F0] rounded-2xl p-6 text-center mb-4">
            <p className="text-[17px] font-bold text-[#1A202C] mb-1">지금은 모집 중인 공고가 없어요</p>
            <p className="text-[14px] text-[#718096]">새 일자리가 나오면 문자로 알려드릴게요.</p>
          </div>
        )}

        {(() => {
          // 카드 JSX는 그대로 추출만 — 그룹(위/접힘/마감)을 나눠 두 번 이상 쓰기 위한 함수화.
          const renderCard = (job: PoolJob) => {
            // 마감된 공고 — 조용히 사라지는 대신 '다음 기회 알림' 수집 카드로 3일간 노출
            if (job.expired) {
              const notified = notifyIds.has(job.id);
              return (
                <section key={job.id} className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-2xl p-5">
                  <span className="inline-block px-2 py-0.5 rounded-md text-[13px] font-extrabold bg-[#EDF2F7] text-[#718096] border border-[#E2E8F0]">
                    마감됨
                  </span>
                  <h2 className="mt-2 text-[17px] font-extrabold text-[#718096] leading-snug">{job.title}</h2>
                  {job.interested && (
                    <p className="mt-2 text-[14px] font-bold text-[#38A169]">
                      ✓ 관심을 접수하셨던 공고예요 — 매니저에게 전달됐어요.
                    </p>
                  )}
                  <p className="mt-2 text-[14px] text-[#A0AEC0] leading-relaxed">
                    이 공고는 마감됐어요. 비슷한 일자리가 나오면 먼저 안내받으실 수 있어요.
                  </p>
                  {notified ? (
                    <p className="mt-3 py-3 text-[15px] font-bold text-[#38A169] text-center">
                      ✓ 네, 새 일자리가 나오면 먼저 안내드릴게요
                    </p>
                  ) : (
                    <button
                      onClick={() => expressNotify(job)}
                      disabled={sendingId !== null}
                      className="mt-3 w-full py-3 rounded-xl text-[16px] font-extrabold bg-white border-2 border-[#CBD5E0] text-[#4A5568] hover:bg-[#EDF2F7] active:bg-[#EDF2F7]"
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
              <section key={job.id} className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  {/* 상황 배지 — '나 이 자리 어디까지 했더라'를 카드가 먼저 답한다(문구 규칙은 lib/pool-status). */}
                  {job.status === "talking" && (
                    <span className="inline-block px-2 py-0.5 rounded-md text-[13px] font-extrabold bg-[#F0FFF4] text-[#2F855A] border border-[#C6F6D5]">
                      💬 이야기 중
                    </span>
                  )}
                  {job.status === "paused" && (
                    <span className="inline-block px-2 py-0.5 rounded-md text-[13px] font-extrabold bg-[#EBF8FF] text-[#2B6CB0] border border-[#BEE3F8]">
                      매니저 확인 중
                    </span>
                  )}
                  {job.work_period && (
                    <span
                      className={`inline-block px-2 py-0.5 rounded-md text-[13px] font-extrabold ${
                        job.work_period === "정기"
                          ? "bg-[#F0FFF4] text-[#2F855A] border border-[#C6F6D5]"
                          : "bg-[#FFF9E6] text-[#B7791F] border border-[#F6E4B0]"
                      }`}
                    >
                      {PERIOD_LABEL[job.work_period] ?? job.work_period}
                    </span>
                  )}
                  {job.closes_at && (
                    <span className="inline-block px-2 py-0.5 rounded-md text-[13px] font-extrabold bg-[#FFF5F5] text-[#C53030] border border-[#FED7D7]">
                      ⏰ {closesLabel(job.closes_at)}
                    </span>
                  )}
                </div>
                {/* 제목의 끝 '(…원)'은 아래 급여 행과 중복이라 표시에서 제거(불필요한 글자↓).
                    '(7/23~8/24)' 같은 날짜 괄호는 원으로 안 끝나 유지된다. */}
                <h2 className="mt-2 text-[18px] font-extrabold text-[#1A202C] leading-snug">
                  {job.title.replace(/\s*\([^)]*원\)\s*$/, "")}
                </h2>
                <dl className="mt-3 flex flex-col gap-1.5 text-[15px] text-[#4A5568]">
                  {pay && (
                    <div className="flex gap-2">
                      <dt className="w-[72px] shrink-0 font-bold text-[#A0AEC0]">급여</dt>
                      <dd className="font-bold text-[#1A202C]">{pay} <span className="font-medium text-[13px] text-[#A0AEC0]">(변동될 수 있어요)</span></dd>
                    </div>
                  )}
                  {(job.branch || job.pickup_address) && (
                    <div className="flex gap-2">
                      <dt className="w-[72px] shrink-0 font-bold text-[#A0AEC0]">{job.branch ? "지점" : "출발지"}</dt>
                      {/* 지점명이 없으면 집결지 주소로 대신 보여주되 **권역까지만** — 상세주소(동/번지 뒤)는
                          확정 후 만남장소 안내에서 알려준다. 링크만 있으면 누구나 보는 화면이다. */}
                      <dd className="break-words">{job.branch || shortArea(job.pickup_address)}</dd>
                    </div>
                  )}
                  {job.distance_km !== null && (
                    <div className="flex gap-2">
                      <dt className="w-[72px] shrink-0 font-bold text-[#A0AEC0]">거리</dt>
                      <dd className="font-bold text-[#38A169]">집에서 약 {job.distance_km}km</dd>
                    </div>
                  )}
                  {job.slot && (
                    <div className="flex gap-2">
                      <dt className="w-[72px] shrink-0 font-bold text-[#A0AEC0]">근무시간</dt>
                      <dd>{job.slot}</dd>
                    </div>
                  )}
                  {job.start_date && (
                    <div className="flex gap-2">
                      <dt className="w-[72px] shrink-0 font-bold text-[#A0AEC0]">시작일</dt>
                      <dd>{startDateLabel(job.start_date)}</dd>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <dt className="w-[72px] shrink-0 font-bold text-[#A0AEC0]">차량</dt>
                    <dd>{job.vehicle_required ? "본인 차량 필요" : "차량 없어도 가능"}</dd>
                  </div>
                  {/* 요건이 어긋난 이유 — 서버 fit 판정(lib/pool-fit)의 문장을 그대로 보여준다(판정 한 곳).
                      카드를 감추지는 않는다 — 차량이 새로 생겼을 수 있고, 판단은 지원자 몫. */}
                  {job.fit_reasons.length > 0 && (
                    <div className="mt-1 rounded-lg bg-[#FFFBEC] border border-[#F6E4B0] px-3 py-2 text-[14px] font-bold text-[#B7791F] leading-snug">
                      {job.fit_reasons.map((r, i) => (
                        <p key={i}>{r}</p>
                      ))}
                      <p className="mt-1 font-semibold text-[#B7791F]">
                        {done ? "매니저가 연락드릴 때 함께 확인할게요." : "그래도 괜찮으시면 관심을 눌러 주세요."}
                      </p>
                    </div>
                  )}
                </dl>

                {job.body && (
                  <div className="mt-3 border-t border-[#EDF2F7] pt-2">
                    {/* 본문은 기본 접힘 — 위 요약(급여·시작일·차량)이 스캔 단위. 프로즈가 요약과 겹쳐
                        기본 노출하면 글자만 많아지고 3개 비교가 어렵다. 원하는 사람만 펼쳐 본다. */}
                    {expandedIds.has(job.id) && (
                      <div className="mt-1 text-[15px] text-[#4A5568] leading-relaxed">
                        {/* 업무 관련 주요 내용(■ 항목 = 운임·요일·시간·차량 등)은 볼드로 강조 */}
                        {job.body.split("\n").map((line, i) => (
                          <p
                            key={i}
                            className={line.trimStart().startsWith("■") ? "font-bold text-[#1A202C]" : ""}
                          >
                            {line || " "}
                          </p>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => toggleExpanded(job.id)}
                      className="py-2.5 mb-2 text-[15px] font-bold text-[#B7791F]"
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
                    className={`mt-5 w-full py-5 rounded-xl text-[18px] font-extrabold transition-colors ${
                      done
                        ? "bg-[#F0FFF4] text-[#38A169] border border-[#9AE6B4]"
                        : sendingId !== null
                          ? "bg-[#EDF2F7] text-[#A0AEC0]"
                          : "bg-[#FFCB3C] text-[#1A202C] hover:bg-[#E0B500] active:bg-[#E0B500]"
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
                  <div className="mt-5 rounded-xl border-2 border-[#FFCB3C] bg-[#FFFBEC] p-3">
                    <p className="text-[16px] font-bold text-[#1A202C] text-center leading-snug">
                      <span className="text-[#B7791F]">{job.title}</span>
                      <br />이 일자리에 관심 있다고 보낼까요?
                    </p>
                    {job.vehicle_required && ownVehicle === "없음" && (
                      <p className="mt-2 text-[14px] font-bold text-[#C05621] text-center leading-snug">
                        본인 차량이 필요한 자리예요 — 괜찮으신가요?
                      </p>
                    )}
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => setConfirmingId(null)}
                        disabled={sendingId !== null}
                        className="flex-1 py-4 rounded-xl text-[17px] font-extrabold bg-white text-[#4A5568] border border-[#CBD5E0]"
                      >
                        아니요
                      </button>
                      <button
                        onClick={() => expressInterest(job)}
                        disabled={sendingId !== null}
                        className="flex-[1.4] py-4 rounded-xl text-[17px] font-extrabold bg-[#FFCB3C] text-[#1A202C] active:bg-[#E0B500] disabled:opacity-70"
                      >
                        {sendingId === job.id ? "보내는 중…" : "네, 보낼게요"}
                      </button>
                    </div>
                  </div>
                )}

                {done && job.status !== "talking" && job.status !== "paused" && (
                  <div className="mt-3 rounded-xl bg-[#FFFBEC] border border-[#F6E4B0] p-3">
                    {/* 이미 '즉시가능' 상태면(이번 클릭이든 과거 응답이든) 질문을 다시 하지 않는다 —
                        새로고침 시 서버의 availability로 재수화 (중복 클릭 방지) */}
                    {immediateIds.has(job.id) || availability === "즉시가능" ? (
                      <p className="text-[15px] font-bold text-[#38A169] text-center">
                        ⚡ 바로 시작 가능 — 확인했어요! 매니저가 참고할게요
                      </p>
                    ) : (
                      <>
                        <p className="text-[15px] font-bold text-[#4A5568] text-center mb-2">
                          혹시 시작일에 바로 시작도 가능하세요?
                        </p>
                        <button
                          onClick={() => expressImmediate(job)}
                          disabled={sendingId !== null}
                          className="w-full py-3 rounded-xl text-[16px] font-extrabold bg-white border-2 border-[#FFCB3C] text-[#1A202C] hover:bg-[#FFF9E6] active:bg-[#FFF9E6]"
                        >
                          {sendingId === job.id ? "확인 중…" : "네, 바로도 가능해요"}
                        </button>
                      </>
                    )}
                  </div>
                )}

                {job.closes_at && (
                  <p className="mt-3 text-[13px] text-[#A0AEC0] text-center leading-relaxed">
                    마감시각이 지나면 새 지원은 받을 수 없어요.
                    <br />먼저 관심 주신 분부터 매니저가 연락드립니다.
                  </p>
                )}
              </section>
            );
          };
          // 서버가 정한 순서를 그대로 따른다(재정렬 금지) — 여기서는 그룹으로 나누기만 한다.
          const activeMain = jobs.filter((j) => !j.expired && j.fit !== "warn");
          const activeOthers = jobs.filter((j) => !j.expired && j.fit === "warn");
          const expiredJobs = jobs.filter((j) => j.expired);
          return (
            <div className="flex flex-col gap-4">
              {activeMain.map(renderCard)}
              {activeOthers.length > 0 && (
                <section>
                  {/* 요건이 어긋난 자리는 접어두되 **숨기지 않는다** — 차량이 새로 생겼을 수 있고 판단은 지원자 몫. */}
                  <button
                    onClick={() => setShowOthers((v) => !v)}
                    className="w-full py-4 rounded-2xl text-[16px] font-extrabold bg-white border-2 border-dashed border-[#CBD5E0] text-[#718096] hover:bg-[#F7FAFC] active:bg-[#F7FAFC]"
                  >
                    {showOthers
                      ? "조건이 다른 자리 접기 ▲"
                      : `조건이 다를 수 있는 자리 ${activeOthers.length}개 더 보기 ▼`}
                  </button>
                  {showOthers && (
                    <div className="mt-4 flex flex-col gap-4">{activeOthers.map(renderCard)}</div>
                  )}
                </section>
              )}
              {expiredJobs.map(renderCard)}
            </div>
          );
        })()}

        <footer className="mt-8 text-center text-[13px] text-[#A0AEC0] leading-relaxed">
          이 페이지는 본인 전용 링크예요. 다른 분과 공유하지 말아주세요.
          <br />관심 표시는 지원 의사 확인이며, 근무 확정은 매니저 안내 후 진행됩니다.
        </footer>
      </div>
    </main>
  );
}
