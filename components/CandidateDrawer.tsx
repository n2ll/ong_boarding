import { X, Phone, MessageSquare, Calendar, Star, FileText, CheckCircle2, Clock } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";

interface CandidateDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  candidate: any;
}

export function CandidateDrawer({ isOpen, onClose, candidate }: CandidateDrawerProps) {
  if (!isOpen || !candidate) return null;

  return (
    <>
      <AnimatePresence>
        <motion.div 
          initial={{ opacity: 0 }} 
          animate={{ opacity: 1 }} 
          exit={{ opacity: 0 }} 
          onClick={onClose}
          className="fixed inset-0 bg-black/30 z-40 backdrop-blur-[2px]" 
        />
      </AnimatePresence>
      
      <AnimatePresence>
        <motion.div 
          initial={{ x: "100%" }} 
          animate={{ x: 0 }} 
          exit={{ x: "100%" }} 
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
          className="fixed top-0 right-0 w-[480px] h-full bg-white shadow-[-10px_0_30px_rgba(0,0,0,0.1)] z-50 flex flex-col border-l border-[#E2E8F0]"
        >
          {/* Header */}
          <div className="p-6 border-b border-[#E2E8F0] flex justify-between items-start bg-[#F7FAFC]">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-[#EDF2F7] text-[#4A5568] flex items-center justify-center font-bold text-[20px] shadow-inner">
                {candidate.name.charAt(0)}
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-[20px] font-extrabold text-[#1A202C]">{candidate.name}</h2>
                  <span className="text-[13px] font-medium text-[#718096] bg-white px-2 py-0.5 rounded-md border border-[#E2E8F0]">
                    {candidate.age}세 · {candidate.gender}
                  </span>
                </div>
                <div className="text-[13px] text-[#A0AEC0] font-mono">{candidate.id} · {candidate.region}</div>
              </div>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-[#E2E8F0] rounded-lg transition-colors text-[#A0AEC0] hover:text-[#1A202C] outline-none">
              <X size={20} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-white">
            
            {/* Action Bar */}
            <div className="flex gap-2">
              <button onClick={() => toast.success(`${candidate.name}님에게 발신을 시도합니다.`)} className="flex-1 bg-[#F7FAFC] hover:bg-[#EDF2F7] border border-[#E2E8F0] text-[#1A202C] py-2.5 rounded-xl text-[13px] font-bold flex justify-center items-center gap-2 transition-colors">
                <Phone size={16} className="text-[#4A5568]" /> 전화 걸기
              </button>
              <button onClick={() => toast.success(`${candidate.name}님에게 알림톡 발송 모달이 열립니다.`)} className="flex-1 bg-[#F7FAFC] hover:bg-[#EDF2F7] border border-[#E2E8F0] text-[#1A202C] py-2.5 rounded-xl text-[13px] font-bold flex justify-center items-center gap-2 transition-colors">
                <MessageSquare size={16} className="text-[#4A5568]" /> 알림톡
              </button>
              <button onClick={() => toast.success(`${candidate.name}님에게 캘린더 면접 제안이 발송되었습니다.`)} className="flex-1 bg-[#1A202C] hover:bg-[#2D3748] text-white py-2.5 rounded-xl text-[13px] font-bold flex justify-center items-center gap-2 transition-colors">
                <Calendar size={16} /> 면접 제안
              </button>
            </div>

            {/* AI Screening Report */}
            <div className="border border-[#E2E8F0] rounded-2xl p-5 shadow-sm bg-[#FFFDF5]">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Star size={18} className="text-[#D69E2E] fill-[#D69E2E]" />
                  <h3 className="text-[14px] font-bold text-[#B7791F]">AI 스크리닝 요약</h3>
                </div>
                <div className={`text-[18px] font-extrabold ${candidate.score >= 90 ? 'text-[#38A169]' : 'text-[#3182CE]'}`}>
                  {candidate.score}점
                </div>
              </div>
              <ul className="space-y-2 text-[13px] text-[#718096] list-disc pl-4 marker:text-[#CBD5E0]">
                <li><b>관련 경력:</b> {candidate.exp} 보유 (근속 기간 양호)</li>
                <li><b>이동 수단:</b> {candidate.tag} 활용으로 피크타임 배차 적합</li>
                <li><b>거주지:</b> 송파권역 중심부와 가까워 긴급 호출 대응 용이</li>
                <li className="text-[#E53E3E]">주의: 야간 근무 경험에 대한 추가 확인 필요</li>
              </ul>
            </div>

            {/* Detail Info */}
            <div>
              <h3 className="text-[14px] font-bold text-[#1A202C] mb-3">상세 지원 정보</h3>
              <div className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl overflow-hidden">
                <div className="flex border-b border-[#E2E8F0]">
                  <div className="w-[120px] bg-[#EDF2F7] p-3 text-[12px] font-bold text-[#4A5568] flex items-center">지원 분야</div>
                  <div className="flex-1 p-3 text-[13px] text-[#1A202C] font-medium">비마트 송파점 야간 파트너</div>
                </div>
                <div className="flex border-b border-[#E2E8F0]">
                  <div className="w-[120px] bg-[#EDF2F7] p-3 text-[12px] font-bold text-[#4A5568] flex items-center">유입 매체</div>
                  <div className="flex-1 p-3 text-[13px] text-[#1A202C] font-medium">Meta Ads (송파구 타겟팅 캠페인)</div>
                </div>
                <div className="flex">
                  <div className="w-[120px] bg-[#EDF2F7] p-3 text-[12px] font-bold text-[#4A5568] flex items-center">연락처</div>
                  <div className="flex-1 p-3 text-[13px] text-[#1A202C] font-medium">010-****-1234</div>
                </div>
              </div>
            </div>

            {/* Timeline */}
            <div>
              <h3 className="text-[14px] font-bold text-[#1A202C] mb-4">활동 타임라인</h3>
              <div className="space-y-4 pl-2 relative">
                <div className="absolute left-[11px] top-2 bottom-2 w-px bg-[#E2E8F0]"></div>
                
                <div className="flex gap-4 relative">
                  <div className="w-6 h-6 rounded-full bg-[#EBF8FF] border-2 border-white flex items-center justify-center shrink-0 z-10">
                    <CheckCircle2 size={12} className="text-[#3182CE]" />
                  </div>
                  <div>
                    <div className="text-[13px] font-bold text-[#1A202C]">AI 대화형 스크리닝 완료</div>
                    <div className="text-[11.5px] text-[#A0AEC0] mt-0.5">{candidate.lastActive}</div>
                  </div>
                </div>

                <div className="flex gap-4 relative">
                  <div className="w-6 h-6 rounded-full bg-[#F0FFF4] border-2 border-white flex items-center justify-center shrink-0 z-10">
                    <FileText size={12} className="text-[#38A169]" />
                  </div>
                  <div>
                    <div className="text-[13px] font-bold text-[#1A202C]">지원서 폼 제출</div>
                    <div className="text-[11.5px] text-[#A0AEC0] mt-0.5">1일 전</div>
                  </div>
                </div>

                <div className="flex gap-4 relative">
                  <div className="w-6 h-6 rounded-full bg-[#EDF2F7] border-2 border-white flex items-center justify-center shrink-0 z-10">
                    <Clock size={12} className="text-[#718096]" />
                  </div>
                  <div>
                    <div className="text-[13px] font-bold text-[#1A202C]">최초 유입 및 세션 시작</div>
                    <div className="text-[11.5px] text-[#A0AEC0] mt-0.5">1일 전</div>
                  </div>
                </div>
              </div>
            </div>

          </div>
          
          {/* Footer Actions */}
          <div className="p-5 border-t border-[#E2E8F0] bg-[#F7FAFC] flex gap-2">
            <button onClick={() => { onClose(); toast.success(`${candidate.name}님이 불합격/보류 처리되었습니다.`); }} className="flex-1 bg-white border border-[#E53E3E] text-[#E53E3E] py-2.5 rounded-xl text-[13px] font-bold hover:bg-[#FFF5F5] transition-colors">
              불합격/보류 처리
            </button>
            <button onClick={() => { onClose(); toast.success(`${candidate.name}님이 다음 파이프라인 단계로 이동되었습니다.`); }} className="flex-[2] bg-[#FFCB3C] text-[#1A202C] py-2.5 rounded-xl text-[13px] font-bold hover:bg-[#E0B500] transition-colors shadow-sm">
              다음 파이프라인으로 이동
            </button>
          </div>
        </motion.div>
      </AnimatePresence>
    </>
  );
}