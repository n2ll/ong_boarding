/**
 * 구인 에이전트 코어 타입.
 *
 * 한 번의 inbound SMS = 한 번의 stage.process() 호출 = 한 번의 Claude 호출.
 * 결과는 응답 텍스트 + 체크리스트 갱신 + 단계 전이 시그널.
 */

export type StageName = "exploration" | "screening" | "onboarding" | "active" | "paused" | "abort";

// ─────────────────────────────────────────────────────────────
// 체크리스트
// ─────────────────────────────────────────────────────────────

/**
 * 스크리닝(screening) 체크리스트 — 8항목.
 * prompts/screening-examples.txt의 운영 항목을 그대로 매핑.
 *
 * - true: 회사가 안내·확인했고 지원자가 인지/동의
 * - false: 아직 미확인
 * - 일부 항목은 "지원자 답이 부정"이면 abort 트리거 (시작일 불가, 자차 없음, 본인명의 불가)
 */
/**
 * 스크리닝 체크리스트 — '시작일'은 매니저 확정 후 안내하므로 제거.
 * "에이전트 질문에 긍정 = 근무 확정"이 절대 아니라는 점을 반영해 시작일을 묻지 않는다.
 */
export interface ScreeningChecklist {
  자차_재확인: boolean;                // 폼 거짓 케이스 대비 — 재확인
  프로모션_종료가능성_안내: boolean;   // "프로모션 5천원 1~2개월 후 종료 가능"
  정산주기_안내: boolean;              // "건당 매주, 프로모션 2주"
  공휴일_업무여부_확인: boolean;       // 양방향
  본인명의_정산_문제없음: boolean;     // 폼 + 재확인
  업무시간_체계_이해: boolean;         // "08~16 배차 기준, 배송시간 별도"
  지원자_질문_해소: boolean;           // 지원자 질문 다 답완료
}

/**
 * 온보딩(onboarding) 체크리스트 — 차량번호 수집 제거.
 * - 진입 즉시 자동 발송: 앱설치+교육 안내 → 앱설치_교육_안내발송됨=true
 * - 지원자 회신에서: 배민_아이디_수신
 * - D-1 cron이 만남장소_안내발송됨=true
 */
export interface OnboardingChecklist {
  앱설치_교육_안내발송됨: boolean;
  배민_아이디_수신: boolean;
  만남장소_안내발송됨: boolean;
}

/**
 * job_candidates.agent_state JSONB의 통합 형태.
 * stage에 맞는 체크리스트만 활성화되어 있다.
 */
export interface AgentState {
  screening?: Partial<ScreeningChecklist>;
  onboarding?: Partial<OnboardingChecklist>;
  /** 단계 전환·자동 발송 등 메타 (디버깅·감사용) */
  meta?: {
    last_run_at?: string;
    last_reasoning?: string;
    transition_count?: number;
    [k: string]: unknown;
  };
}

// ─────────────────────────────────────────────────────────────
// Stage 인터페이스
// ─────────────────────────────────────────────────────────────

export interface JobContext {
  id: number;
  title: string;
  body: string;
  branch: string | null;
  slot: string | null;
  start_date: string | null;
  vehicle_required: boolean;
  pickup_address: string | null;
  site_manager_id: number | null;
}

export interface ApplicantContext {
  id: number;
  name: string | null;
  phone: string;
  birth_date: string | null;
  location: string | null;
  own_vehicle: string | null;
  license_type: string | null;
  vehicle_type: string | null;
  branch1: string | null;
  branch2: string | null;
  work_hours: string | null;
  available_date: string | null;
  self_ownership: string | null;
  introduction: string | null;
  experience: string | null;
}

export interface ConversationTurn {
  direction: "inbound" | "outbound";
  body: string;
  created_at: string;
}

export interface StageContext {
  job: JobContext | null;       // 매칭된 공고 (active 단계 등에선 null 가능)
  applicant: ApplicantContext;
  history: ConversationTurn[];  // 시간순 (오래된 → 최근), 본 인입 제외
  state: AgentState;
}

export type StageTransition =
  | { kind: "stay" }
  | { kind: "advance"; to: StageName; reason: string }
  | { kind: "pause"; reason: string }
  | { kind: "abort"; reason: string };

export interface StageResult {
  /** null이면 응답을 보내지 않음 (예: pause 후 매니저 응대) */
  reply_text: string | null;
  state_update: AgentState;     // 이번 턴에 갱신된 부분만 (deep-merge)
  transition: StageTransition;
  reasoning: string;            // 매니저용 한 줄 설명
  /** Claude 응답 usage + 모델명. router가 outbound 행에 저장 + ai_usage_daily 적재. */
  usage?: {
    model: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
  /** applicants 테이블에 직접 patch할 필드 — onboarding의 baemin_id 같은 추출값 전달용. */
  applicant_patch?: Record<string, unknown>;
}

export interface Stage {
  name: StageName;
  process(ctx: StageContext, inboundText: string): Promise<StageResult>;
}
