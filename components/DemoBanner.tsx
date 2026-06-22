import { FlaskConical } from "lucide-react";

interface DemoBannerProps {
  /** 이 화면이 어떤 상태인지: 'demo'(데모 데이터) | 'soon'(준비 중) */
  variant?: "demo" | "soon";
  /** 보조 설명 (무엇이 아직 실데이터가 아닌지) */
  note?: string;
}

/**
 * 목업/준비중 화면 상단에 정직하게 표기하는 배너.
 * 실데이터로 연동되기 전까지 노출해, 실무자가 화면을 오해하지 않도록 한다.
 */
export function DemoBanner({ variant = "demo", note }: DemoBannerProps) {
  const isSoon = variant === "soon";
  return (
    <div className="flex items-start gap-3 bg-[#FFFBEB] border border-[#F6E05E] rounded-xl px-4 py-3 mb-6">
      <div className="w-7 h-7 rounded-lg bg-[#FEFCBF] flex items-center justify-center shrink-0 mt-0.5">
        <FlaskConical size={15} className="text-[#B7791F]" />
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-extrabold text-[#975A16] flex items-center gap-2">
          {isSoon ? "준비 중인 화면입니다" : "데모 화면입니다"}
          <span className="text-[10px] font-bold text-[#1A202C] bg-[#FEFCBF] px-1.5 py-0.5 rounded">
            {isSoon ? "COMING SOON" : "DEMO"}
          </span>
        </div>
        <div className="text-[12.5px] text-[#975A16]/80 leading-relaxed mt-0.5">
          {note ??
            (isSoon
              ? "백엔드 연동 전이라 동작은 아직 제공되지 않습니다. 화면 구성·흐름 미리보기 용도입니다."
              : "표시된 수치·항목은 예시 데이터이며 실제 운영 데이터가 아닙니다. 연동 작업이 진행 중입니다.")}
        </div>
      </div>
    </div>
  );
}
