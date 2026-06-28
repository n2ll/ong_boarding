"use client";

/**
 * 인재풀 지도 분포 뷰 (Pipeline의 세 번째 뷰).
 *
 * - 좌측: 네이버 지도(Web Dynamic Map) — 지원자 좌표 핀 + (좌표 있는)공고 픽업 위치 마커.
 *   geo_precision='approx'(시군구 폴백 좌표)는 흐리게 표시해 정확도를 구분.
 * - 우측: 시/군/구별 분포 요약(랭킹 바). 지도 키 없이도 항상 동작.
 *
 * 네이버 지도는 NEXT_PUBLIC_NAVER_MAPS_CLIENT_ID(Web Dynamic Map 클라이언트 ID) + 도메인 등록이
 * 필요하다. 키가 없으면 지도 영역에 설정 안내를 띄우고 분포 요약만 보여준다.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { MapPin, Briefcase, Info } from "lucide-react";

export interface MapApplicant {
  id: number;
  name: string | null;
  lat: number | null;
  lng: number | null;
  sigungu: string | null;
  sido: string | null;
  geo_precision: string | null;
  status: string | null;
}

export interface MapJob {
  id: number;
  title: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  pickup_address: string | null;
}

// 네이버 지도 SDK는 런타임 전역(window.naver). 타입은 느슨하게 다룬다.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    naver?: any;
  }
}

const SCRIPT_ID = "naver-maps-sdk";
const SEOUL = { lat: 37.5665, lng: 126.978 };

// 스크립트 태그를 1회만 주입하고, window.naver.maps가 준비될 때까지 폴링한다.
// onload 리스너에만 의존하면 React StrictMode 이중 마운트/이른 주입 시 init을 놓칠 수 있어
// 폴링으로 준비 상태를 직접 확인한다.
function loadNaverScript(clientId: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.naver?.maps) return resolve();
    if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement("script");
      s.id = SCRIPT_ID;
      // NAVER Maps v3 현재 표준: oapi 도메인 + ncpKeyId (구 openapi/ncpClientId는 레거시)
      s.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${clientId}`;
      s.async = true;
      document.head.appendChild(s);
    }
    const start = Date.now();
    const timer = setInterval(() => {
      if (window.naver?.maps) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("naver maps load timeout"));
      }
    }, 100);
  });
}

export function PipelineMap({ applicants, jobs }: { applicants: MapApplicant[]; jobs: MapJob[] }) {
  const clientId = process.env.NEXT_PUBLIC_NAVER_MAPS_CLIENT_ID;
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const withCoords = useMemo(
    () => applicants.filter((a) => a.lat != null && a.lng != null),
    [applicants]
  );

  // 시/군/구별 분포. 시군구·시도 둘 다 없는 건(주소 미입력/지오코딩 실패) 별도 버킷으로 분리해
  // 실제 지역 랭킹이 묻히지 않게 한다.
  const { regions, unknownCount } = useMemo(() => {
    const counts = new Map<string, number>();
    let unknown = 0;
    for (const a of applicants) {
      const sig = a.sigungu?.trim();
      const sido = a.sido?.trim();
      if (sig) counts.set(sig, (counts.get(sig) ?? 0) + 1);
      else if (sido) {
        const k = `${sido} (구 미상)`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      } else unknown++;
    }
    const regions = Array.from(counts.entries())
      .map(([region, count]) => ({ region, count }))
      .sort((a, b) => b.count - a.count);
    return { regions, unknownCount: unknown };
  }, [applicants]);

  const maxCount = regions[0]?.count ?? 1;
  const jobsWithCoords = useMemo(
    () => jobs.filter((j) => j.pickup_lat != null && j.pickup_lng != null),
    [jobs]
  );

  // 지도 초기화 (키 있을 때만)
  useEffect(() => {
    if (!clientId || !mapEl.current) return;
    let cancelled = false;
    setStatus("loading");
    loadNaverScript(clientId)
      // 컨테이너가 레이아웃되어 실제 크기를 가질 때까지 대기.
      // 0×0 상태에서 지도를 만들면 내부 projection이 null이 되어 마커 추가 시 크래시한다.
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            const start = Date.now();
            const t = setInterval(() => {
              if (cancelled) {
                clearInterval(t);
                return resolve();
              }
              const el = mapEl.current;
              if (el && el.clientHeight > 0 && el.clientWidth > 0) {
                clearInterval(t);
                resolve();
              } else if (Date.now() - start > 5000) {
                clearInterval(t);
                reject(new Error("map container has no size"));
              }
            }, 80);
          })
      )
      .then(() => {
        if (cancelled || !mapEl.current || mapRef.current) return;
        const naver = window.naver;
        mapRef.current = new naver.maps.Map(mapEl.current, {
          center: new naver.maps.LatLng(SEOUL.lat, SEOUL.lng),
          zoom: 11,
          mapDataControl: false,
        });
        setStatus("ready");
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  // 마커 갱신
  useEffect(() => {
    if (status !== "ready" || !mapRef.current) return;
    const naver = window.naver;
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    const bounds = new naver.maps.LatLngBounds();
    let hasPoint = false;

    for (const a of withCoords) {
      const approx = a.geo_precision === "approx";
      const pos = new naver.maps.LatLng(Number(a.lat), Number(a.lng));
      const marker = new naver.maps.Marker({
        position: pos,
        map: mapRef.current,
        title: a.name ?? "",
        icon: {
          content: `<div style="width:11px;height:11px;border-radius:50%;background:${
            approx ? "#FBD38D" : "#DD6B20"
          };border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.15);opacity:${approx ? 0.7 : 1}"></div>`,
          anchor: new naver.maps.Point(7, 7),
        },
      });
      markersRef.current.push(marker);
      bounds.extend(pos);
      hasPoint = true;
    }

    for (const j of jobsWithCoords) {
      const pos = new naver.maps.LatLng(Number(j.pickup_lat), Number(j.pickup_lng));
      const marker = new naver.maps.Marker({
        position: pos,
        map: mapRef.current,
        title: j.title,
        icon: {
          content: `<div style="display:flex;align-items:center;gap:4px;background:#1A202C;color:#FFCB3C;font-size:11px;font-weight:700;padding:3px 7px;border-radius:8px;border:1px solid #FFCB3C;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.25)">📍 ${j.title}</div>`,
          anchor: new naver.maps.Point(10, 12),
        },
      });
      markersRef.current.push(marker);
      bounds.extend(pos);
      hasPoint = true;
    }

    if (hasPoint) mapRef.current.fitBounds(bounds);
  }, [status, withCoords, jobsWithCoords]);

  return (
    <div className="h-full flex gap-4 p-4 bg-[#F7FAFC]">
      {/* 지도 영역 */}
      <div className="flex-1 rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden relative min-w-0">
        {clientId ? (
          <>
            <div ref={mapEl} className="w-full h-full" />
            {status !== "ready" && (
              <div className="absolute inset-0 flex items-center justify-center text-[13px] text-[#718096] bg-white/70">
                {status === "error" ? "지도를 불러오지 못했어요 (클라이언트 ID·도메인 등록 확인)" : "지도 불러오는 중…"}
              </div>
            )}
            {/* 범례 */}
            <div className="absolute bottom-3 left-3 bg-white/95 border border-[#E2E8F0] rounded-lg px-3 py-2 text-[11px] text-[#4A5568] shadow-sm flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[#DD6B20] inline-block" /> 정확 좌표</div>
              <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[#FBD38D] inline-block" /> 시군구 근사</div>
              <div className="flex items-center gap-1.5"><span className="text-[#FFCB3C]">📍</span> 공고 위치</div>
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
            <div className="w-12 h-12 rounded-2xl bg-[#FFFAF0] border border-[#FBD38D] flex items-center justify-center text-[#DD6B20]">
              <MapPin size={22} />
            </div>
            <div className="text-[15px] font-bold text-[#1A202C]">지도 키 설정이 필요해요</div>
            <p className="text-[12.5px] text-[#718096] leading-relaxed max-w-[420px]">
              네이버 클라우드 <b>Maps · Web Dynamic Map</b> 클라이언트 ID를{" "}
              <code className="px-1 py-0.5 rounded bg-[#EDF2F7] text-[#4A5568]">NEXT_PUBLIC_NAVER_MAPS_CLIENT_ID</code>{" "}
              에 넣고 서비스 도메인을 등록하면 지도가 표시됩니다. 그동안은 우측 분포 요약으로 지역 현황을 확인하세요.
            </p>
          </div>
        )}
      </div>

      {/* 시군구 분포 요약 */}
      <div className="w-[320px] shrink-0 rounded-2xl border border-[#E2E8F0] bg-white flex flex-col overflow-hidden">
        <div className="px-4 py-3.5 border-b border-[#E2E8F0] bg-[#FFFDF8]">
          <h3 className="text-[14px] font-extrabold text-[#1A202C] flex items-center gap-1.5">
            <MapPin size={15} className="text-[#DD6B20]" /> 지역별 인력 분포
          </h3>
          <div className="text-[11.5px] text-[#718096] mt-1 flex items-center gap-2 flex-wrap">
            <span>총 {applicants.length.toLocaleString()}명</span>
            <span className="text-[#CBD5E0]">·</span>
            <span>좌표 {withCoords.length.toLocaleString()}명</span>
            {jobsWithCoords.length > 0 && (
              <>
                <span className="text-[#CBD5E0]">·</span>
                <span className="flex items-center gap-1"><Briefcase size={11} /> 공고 {jobsWithCoords.length}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-custom p-2">
          {regions.length === 0 && unknownCount === 0 ? (
            <div className="text-center text-[12.5px] text-[#A0AEC0] py-8">표시할 지원자가 없어요.</div>
          ) : (
            <>
              {regions.map((d) => (
                <div key={d.region} className="px-2.5 py-2 rounded-lg hover:bg-[#F7FAFC]">
                  <div className="flex items-center justify-between text-[12.5px] mb-1">
                    <span className="font-bold text-[#2D3748] truncate">{d.region}</span>
                    <span className="font-extrabold text-[#1A202C] tabular-nums ml-2">{d.count}</span>
                  </div>
                  <div className="h-1.5 w-full bg-[#F1F4F8] rounded-full overflow-hidden">
                    <div className="h-full bg-[#DD6B20] rounded-full" style={{ width: `${(d.count / maxCount) * 100}%` }} />
                  </div>
                </div>
              ))}
              {unknownCount > 0 && (
                <div className="mt-1.5 mx-1 px-2.5 py-2 rounded-lg bg-[#F7FAFC] flex items-center justify-between text-[12px] text-[#A0AEC0]">
                  <span className="font-semibold">주소 미입력</span>
                  <span className="font-bold tabular-nums">{unknownCount.toLocaleString()}</span>
                </div>
              )}
            </>
          )}
        </div>
        {jobsWithCoords.length === 0 && jobs.length > 0 && (
          <div className="px-3 py-2.5 border-t border-[#E2E8F0] bg-[#F7FAFC] text-[11px] text-[#718096] flex items-start gap-1.5">
            <Info size={13} className="mt-0.5 shrink-0" />
            공고에 픽업 주소가 입력되면 지도에 위치가 함께 표시됩니다.
          </div>
        )}
      </div>
    </div>
  );
}
