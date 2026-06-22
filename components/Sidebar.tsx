import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Activity,
  BarChart2,
  MessageSquare,
  Inbox,
  Brain,
  Users,
  Search,
  CheckCircle,
  Briefcase,
  Building2,
  MapPin,
  Shield,
  Settings,
  ChevronRight
} from "lucide-react";

export function Sidebar() {
  const pathname = usePathname();

  const navItems = [
    { label: "개요", type: "header" },
    { label: "대시보드", icon: LayoutDashboard, path: "/" },
    { label: "자동화 현황", icon: Activity, path: "/automation", badge: "dot-green" },
    { label: "리포트 · 분석", icon: BarChart2, path: "/reports" },
    
    { label: "AI 에이전트", type: "header" },
    { label: "실시간 응대", icon: MessageSquare, path: "/live", badge: "count", count: 2 },
    { label: "미분류 인박스", icon: Inbox, path: "/inbox" },
    { label: "에이전트 두뇌", icon: Brain, path: "/brain" },
    
    { label: "인재 관리", type: "header" },
    { label: "인력 소싱", icon: Search, path: "/sourcing", badge: "dot-green" },
    { label: "인재풀 · 파이프라인", icon: Users, path: "/pipeline", badge: "count-yellow", count: 14 },
    { label: "AI 인재 추천", icon: CheckCircle, path: "/recommendations" },
    
    { label: "채용 운영", type: "header" },
    { label: "채용공고 관리", icon: Briefcase, path: "/jobs" },
    { label: "화주사 관리", icon: Building2, path: "/clients" },
    { label: "지점 관리", icon: MapPin, path: "/branches" },
    { label: "팀 · 권한", icon: Shield, path: "/team" },
    { label: "설정", icon: Settings, path: "/settings" },
  ];

  return (
    <aside className="w-[248px] shrink-0 bg-[#1A202C] text-white flex flex-col h-full">
      <div className="pt-[26px] px-[22px] pb-[22px] flex items-center gap-[11px] border-b border-white/5">
        <div className="w-[38px] h-[38px] rounded-[10px] bg-[#FFCB3C] flex items-center justify-center font-black text-[21px] text-[#1A202C] tracking-tight">
          옹
        </div>
        <div>
          <div className="font-extrabold text-[20px] tracking-tight leading-none">옹보딩</div>
          <div className="text-[11px] text-white/50 tracking-wide mt-[3px] font-medium">시니어 채용 운영</div>
        </div>
      </div>

      <nav className="p-3 flex flex-col gap-0.5 flex-1 overflow-y-auto">
        {navItems.map((item, idx) => {
          if (item.type === "header") {
            return (
              // Accessibility Improvement (A): Changed text-white/30 to text-white/50 for better contrast
              <div key={idx} className="text-[10.5px] font-bold text-white/50 tracking-widest px-3 pt-3.5 pb-1.5 first:pt-2">
                {item.label}
              </div>
            );
          }

          const isActive = pathname === item.path;
          const Icon = item.icon!;

          return (
            <Link
              key={idx}
              href={item.path!}
              // Accessibility Improvement (A): Added focus-visible classes for keyboard navigation
              className={`flex items-center gap-3 px-3 py-2.5 rounded-[10px] text-sm cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] ${
                isActive ? "bg-white/10 text-white font-bold" : "text-white/70 hover:bg-white/5 font-medium hover:text-white"
              }`}
            >
              <Icon size={18} className={`shrink-0 ${isActive ? "opacity-100" : "opacity-70"}`} strokeWidth={isActive ? 2.5 : 2} />
              <span className="flex-1">{item.label}</span>
              
              {item.badge === "dot-green" && <span className="w-1.5 h-1.5 rounded-full bg-[#38A169] shrink-0"></span>}
              {item.badge === "count" && (
                <span className="bg-[#E53E3E] text-white text-[11px] font-extrabold px-[7px] py-[1px] rounded-full tracking-tight">
                  {item.count}
                </span>
              )}
              {item.badge === "count-yellow" && (
                <span className="bg-[#FFCB3C] text-[#1A202C] text-[11px] font-extrabold px-[7px] py-[1px] rounded-full tracking-tight">
                  {item.count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="m-3.5 p-3 rounded-xl bg-white/5 flex items-center gap-[11px]">
        <div className="w-[38px] h-[38px] rounded-[10px] bg-[#3C2414] flex items-center justify-center font-bold text-[15px] text-[#FFCB3C] shrink-0">
          정현
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[14px] leading-tight text-white truncate">정현강</div>
          <div className="text-[12px] text-white/50 truncate">채용 총괄 · 본사</div>
        </div>
        <ChevronRight size={16} className="text-white/40" />
      </div>
    </aside>
  );
}
