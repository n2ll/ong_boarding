"use client";

/**
 * /p/[token] — 무로그인 맞춤 공고 페이지 (pull 채널, PRODUCT_DIRECTION §5.5[3]·§6).
 *
 * 인력풀 지원자가 SMS로 받은 본인 전용 링크. 앱 설치·로그인 없이
 * 지금 모집 중인 공고를 확인하고 '관심 있음'을 남긴다.
 * 관심 표시 = 가능 의사 수집일 뿐 — 배정·확정 뉘앙스 금지(확정은 매니저).
 * 시니어 친화: 큰 글씨·큰 터치 영역·단순 구조.
 */

import { useEffect, useState } from "react";
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
  if (j.pay_type && AMOUNT_PAY_TYPES.has(j.pay_type) && typeof j.pay_amount === "number") {
    return `${j.pay_type} ${j.pay_amount.toLocaleString("ko-KR")}원`;
  }
  if (j.pay_type === "혼합" || j.pay_type === "협의") {
    return j.pay_info || j.pay_type;
  }
  if (j.pay_type) return j.pay_type;
  if (j.pay_info) return j.pay_info;
  return null;
}

/** 시작일 → 'YYYY-MM-DD'면 'M월 D일'로, 자유 텍스트면 원문 그대로 */
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
  const [doneIds, setDoneIds] = useState<Set<number>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [immediateIds, setImmediateIds] = useState<Set<number>>(new Set());
  const [notifyIds, setNotifyIds] = useState<Set<number>>(new Set());

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
    fetch(`/api/pool/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const json = await res.json();
        setName(json.name ?? null);
        setAvailability(json.availability ?? null);
        setJobs(json.jobs ?? []);
        setDoneIds(new Set((json.jobs ?? []).filter((j: PoolJob) => j.interested).map((j: PoolJob) => j.id)));
        setNotifyIds(new Set((json.jobs ?? []).filter((j: PoolJob) => j.notified).map((j: PoolJob) => j.id)));
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
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

  // 마감된 공고 카드의 "다음 급구 때 먼저 알려주세요" — 놓친 지원자의 가용성 수집
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

        <div className="flex flex-col gap-4">
          {jobs.map((job) => {
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
                    이 공고는 마감됐어요. 비슷한 급구 건이 생기면 먼저 안내받으실 수 있어요.
                  </p>
                  {notified ? (
                    <p className="mt-3 py-3 text-[15px] font-bold text-[#38A169] text-center">
                      ✓ 다음 급구 때 먼저 안내드릴게요
                    </p>
                  ) : (
                    <button
                      onClick={() => expressNotify(job)}
                      disabled={sendingId === job.id}
                      className="mt-3 w-full py-3 rounded-xl text-[16px] font-extrabold bg-white border-2 border-[#CBD5E0] text-[#4A5568] hover:bg-[#EDF2F7] active:bg-[#EDF2F7]"
                    >
                      {sendingId === job.id ? "접수 중…" : "다음 급구 때 먼저 알려주세요"}
                    </button>
                  )}
                </section>
              );
            }

            const done = doneIds.has(job.id);
            const pay = payLabel(job);
            return (
              <section key={job.id} className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm">
                <div className="flex flex-wrap items-center gap-1.5">
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
                <h2 className="mt-2 text-[18px] font-extrabold text-[#1A202C] leading-snug">{job.title}</h2>
                <dl className="mt-3 flex flex-col gap-1.5 text-[15px] text-[#4A5568]">
                  {pay && (
                    <div className="flex gap-2">
                      <dt className="w-[72px] shrink-0 font-bold text-[#A0AEC0]">급여</dt>
                      <dd className="font-bold text-[#1A202C]">{pay} <span className="font-medium text-[13px] text-[#A0AEC0]">(변동될 수 있어요)</span></dd>
                    </div>
                  )}
                  {job.branch && (
                    <div className="flex gap-2">
                      <dt className="w-[72px] shrink-0 font-bold text-[#A0AEC0]">지점</dt>
                      <dd>{job.branch}{job.distance_km !== null && <span className="text-[#38A169] font-bold"> · 약 {job.distance_km}km</span>}</dd>
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
                </dl>

                {job.body && (
                  <div className="mt-3 border-t border-[#EDF2F7] pt-3">
                    <p
                      className={`text-[15px] text-[#4A5568] leading-relaxed whitespace-pre-line ${
                        expandedIds.has(job.id) ? "" : "line-clamp-4"
                      }`}
                    >
                      {job.body}
                    </p>
                    {job.body.split("\n").length > 4 && (
                      <button
                        onClick={() => toggleExpanded(job.id)}
                        className="mt-1 py-1 text-[15px] font-bold text-[#B7791F]"
                      >
                        {expandedIds.has(job.id) ? "접기 ▲" : "자세한 내용 보기 ▼"}
                      </button>
                    )}
                  </div>
                )}

                <button
                  onClick={() => expressInterest(job)}
                  disabled={done || sendingId === job.id}
                  className={`mt-4 w-full py-4 rounded-xl text-[17px] font-extrabold transition-colors ${
                    done
                      ? "bg-[#F0FFF4] text-[#38A169] border border-[#9AE6B4]"
                      : "bg-[#FFCB3C] text-[#1A202C] hover:bg-[#E0B500] active:bg-[#E0B500]"
                  } disabled:cursor-default`}
                >
                  {done ? "✓ 접수됐어요 — 매니저가 연락드릴게요" : sendingId === job.id ? "접수 중…" : "관심 있어요"}
                </button>

                {done && (
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
                          disabled={sendingId === job.id}
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
          })}
        </div>

        <footer className="mt-8 text-center text-[13px] text-[#A0AEC0] leading-relaxed">
          이 페이지는 본인 전용 링크예요. 다른 분과 공유하지 말아주세요.
          <br />관심 표시는 지원 의사 확인이며, 근무 확정은 매니저 안내 후 진행됩니다.
        </footer>
      </div>
    </main>
  );
}
