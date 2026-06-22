"use client";

import { Megaphone, Users, Bot, ArrowRight } from "lucide-react";

type Stage = "inflow" | "pool" | "ops";

interface StageDef {
  key: Stage;
  group: "A" | "B";
  title: string;
  desc: string;
  icon: typeof Megaphone;
}

const STAGES: StageDef[] = [
  { key: "inflow", group: "A", title: "외부 채널 게시", desc: "당근알바·알바몬·잡코리아에 공고 노출 → 신규 유입", icon: Megaphone },
  { key: "pool", group: "B", title: "자체 인력풀 적재", desc: "유입·수기 등록 인력을 우리 DB로 통합 관리", icon: Users },
  { key: "ops", group: "B", title: "옹봇 AI 운영", desc: "매칭·스크리닝·온보딩까지 자동 운영", icon: Bot },
];

/**
 * (A) 외부 유입 → (B) 자체 풀 운영 흐름을 한 줄로 보여주는 안내 배너.
 * active로 현재 화면이 어느 단계인지 강조한다.
 */
export function RecruitFlowBanner({ active }: { active: Stage }) {
  return (
    <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-sm px-5 py-4 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] font-extrabold text-white bg-[#1A202C] px-2 py-0.5 rounded">채용 흐름</span>
        <span className="text-[12.5px] font-semibold text-[#718096]">
          <b className="text-[#DD6B20]">(A) 외부 채널 게시</b>로 유입을 만들고, <b className="text-[#3182CE]">(B) 자체 인력풀</b>을 옹봇이 자동 운영합니다.
        </span>
      </div>
      <div className="flex items-stretch gap-2">
        {STAGES.map((s, i) => {
          const on = s.key === active;
          const isA = s.group === "A";
          const accent = isA ? "#DD6B20" : "#3182CE";
          const soft = isA ? "#FFFAF0" : "#EBF8FF";
          const Icon = s.icon;
          return (
            <div key={s.key} className="flex items-stretch gap-2 flex-1">
              <div
                className={`flex-1 flex items-center gap-3 rounded-xl px-3.5 py-2.5 border transition-all ${on ? "shadow-sm" : "opacity-70"}`}
                style={{ borderColor: on ? accent : "#E2E8F0", backgroundColor: on ? soft : "#fff" }}
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: soft, color: accent }}>
                  <Icon size={16} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-extrabold px-1.5 py-0.5 rounded" style={{ backgroundColor: accent, color: "#fff" }}>{s.group}</span>
                    <span className="text-[13px] font-extrabold text-[#1A202C] truncate">{s.title}</span>
                  </div>
                  <div className="text-[11.5px] text-[#718096] truncate mt-0.5">{s.desc}</div>
                </div>
              </div>
              {i < STAGES.length - 1 && (
                <div className="flex items-center text-[#CBD5E0] shrink-0"><ArrowRight size={18} /></div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
