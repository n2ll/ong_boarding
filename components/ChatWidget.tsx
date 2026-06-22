import { useState, useEffect } from "react";
import { X, Send, Minimize2, Maximize2, AlertTriangle, User, MoreHorizontal, Bot } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [isHumanTakeover, setIsHumanTakeover] = useState(false);
  const [messages, setMessages] = useState([
    { id: 1, sender: "bot", text: "안녕하세요! 비마트 송파점 지원에 감사드립니다. 몇 가지 확인을 위해 질문드려도 될까요?", time: "14:30" },
    { id: 2, sender: "user", text: "네 안녕하세요. 가능합니다.", time: "14:31" },
    { id: 3, sender: "bot", text: "오토바이 배달 경험이 있으신데, 해당 지역 지리에 익숙하신가요?", time: "14:31" },
    { id: 4, sender: "user", text: "네 송파구에서 3년정도 배달했습니다.", time: "14:32" },
    { id: 5, sender: "bot", text: "야간 근무(22시~02시)도 가능하신가요?", time: "14:32" },
    { id: 6, sender: "user", text: "근무 요일에 따라 다릅니다. 주말 야간은 가능한데 평일은 힘듭니다.", time: "14:33" }
  ]);
  const [inputValue, setInputValue] = useState("");
  const [pulseAlert, setPulseAlert] = useState(true);

  useEffect(() => {
    const handleOpen = (e: Event) => {
      setIsOpen(true);
      // Simulate context loading based on event detail if needed
      setPulseAlert(true);
      setTimeout(() => setPulseAlert(false), 3000);
    };
    window.addEventListener("open-chat-widget", handleOpen);
    return () => window.removeEventListener("open-chat-widget", handleOpen);
  }, []);

  const handleSend = () => {
    if (!inputValue.trim()) return;
    setMessages(prev => [...prev, { id: Date.now(), sender: "human", text: inputValue, time: "14:35" }]);
    setInputValue("");
    setIsHumanTakeover(true);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div 
          initial={{ opacity: 0, y: 50, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 50, scale: 0.95 }}
          transition={{ duration: 0.2 }}
          className="fixed bottom-6 right-6 w-[380px] h-[600px] max-h-[80vh] bg-white rounded-2xl shadow-2xl border border-[#E2E8F0] flex flex-col z-[100] overflow-hidden"
        >
          {/* Header */}
          <div className="bg-[#1A202C] text-white p-4 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#EBF8FF] text-[#3182CE] flex items-center justify-center font-bold text-[16px]">
                김
              </div>
              <div>
                <h3 className="text-[15px] font-bold">김철수 지원자</h3>
                <span className="text-[12px] text-white/70">도보배달 · 서류 합격</span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-white/70 hover:text-white" onClick={() => setIsOpen(false)}>
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Alert Banner */}
          {!isHumanTakeover && (
            <div className={`bg-[#FFFBEB] px-4 py-2.5 flex items-start gap-2 border-b border-[#F6E05E] transition-colors duration-1000 ${pulseAlert ? 'bg-[#FEFCBF]' : ''}`}>
              <AlertTriangle size={16} className="text-[#D69E2E] mt-0.5 shrink-0" />
              <div className="flex-1">
                <div className="text-[12.5px] font-bold text-[#975A16]">AI가 대답하기 어려운 문맥입니다.</div>
                <div className="text-[11.5px] text-[#B8860B] mt-0.5 leading-snug">
                  주말 야간만 가능하다는 조건에 대한 페이/시간 협의가 필요합니다.
                </div>
              </div>
              <button 
                onClick={() => setIsHumanTakeover(true)}
                className="shrink-0 bg-[#D69E2E] hover:bg-[#B8860B] text-white px-2.5 py-1.5 rounded-md text-[11px] font-bold transition-colors"
              >
                개입하기
              </button>
            </div>
          )}

          {isHumanTakeover && (
            <div className="bg-[#EBF8FF] px-4 py-2 flex items-center justify-center border-b border-[#BEE3F8]">
              <span className="text-[11.5px] font-bold text-[#2B6CB0]">현재 매니저님이 직접 응대 중입니다. (AI 일시정지)</span>
            </div>
          )}

          {/* Chat Messages */}
          <div className="flex-1 overflow-y-auto p-4 bg-[#F7FAFC] flex flex-col gap-3">
            {messages.map((msg) => {
              const isMe = msg.sender === "human" || msg.sender === "bot";
              return (
                <div key={msg.id} className={`flex flex-col max-w-[85%] ${isMe ? 'self-end items-end' : 'self-start items-start'}`}>
                  {msg.sender === "bot" && (
                    <div className="flex items-center gap-1.5 text-[11px] text-[#718096] mb-1 mr-1">
                      <Bot size={12} /> AI 옹봇
                    </div>
                  )}
                  {msg.sender === "human" && (
                    <div className="flex items-center gap-1.5 text-[11px] text-[#3182CE] mb-1 mr-1 font-bold">
                      매니저 (나)
                    </div>
                  )}
                  <div className={`px-3.5 py-2.5 rounded-2xl text-[13.5px] leading-relaxed shadow-sm ${
                    msg.sender === "bot" ? "bg-white border border-[#E2E8F0] text-[#1A202C] rounded-tr-sm" : 
                    msg.sender === "human" ? "bg-[#FFCB3C] text-[#1A202C] font-medium rounded-tr-sm" : 
                    "bg-[#1A202C] text-white rounded-tl-sm"
                  }`}>
                    {msg.text}
                  </div>
                  <span className="text-[10px] text-[#A0AEC0] mt-1 mx-1">{msg.time}</span>
                </div>
              );
            })}
          </div>

          {/* Input */}
          <div className="p-3 border-t border-[#E2E8F0] bg-white flex items-end gap-2">
            <textarea 
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={isHumanTakeover ? "메시지를 입력하세요..." : "메시지 입력 시 AI가 정지되고 직접 응대합니다."}
              className="flex-1 max-h-[100px] min-h-[44px] bg-[#F1F4F8] border-0 rounded-xl px-4 py-2.5 text-[13.5px] focus:ring-2 focus:ring-[#FFCB3C] resize-none focus:outline-none"
              rows={1}
            />
            <button 
              onClick={handleSend}
              className={`w-[44px] h-[44px] rounded-xl flex items-center justify-center shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1A202C] ${inputValue.trim() ? 'bg-[#1A202C] text-[#FFCB3C]' : 'bg-[#E2E8F0] text-[#A0AEC0]'}`}
            >
              <Send size={18} className={inputValue.trim() ? 'ml-0.5' : ''} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}