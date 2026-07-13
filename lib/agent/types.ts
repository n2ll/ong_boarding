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
 * - 만남장소_안내발송됨: 현재 미사용 (만남장소 자동 발송/D-day cron 미구현 — 매니저 수동)
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
    /** pause 시점 구조화 인계 정보(P1a) — 큐 카테고리·추천액션의 1순위 소스 */
    pause?: {
      category?: string | null;
      summary?: string | null;
      suggested_action?: string | null;
    };
    /** 일반 라인(internal 공고) 스크리닝 수집값 — 차종·시작 가능일·선탑 가능 시간대·법인차 렌트 희망 */
    general_screening?: {
      차종?: string;
      시작가능일?: string;
      선탑_가능시간?: string;
      법인차_렌트_희망?: boolean;
    };
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
  /** 급여·정산 정보 — 있으면 에이전트가 단가 질문에 직접 답(없으면 pause). */
  pay_info?: string | null;
  /** 고용형태·보험 등 정책 안내 — 있으면 에이전트가 직접 답(없으면 pause). */
  policy_notes?: string | null;
  /** 대표 단가 형태 (건당/일당/주급/월급/혼합/협의) — pull 공고 카드 표시 + 프롬프트 주입. */
  pay_type?: string | null;
  /** 대표 금액(원, pay_type 기준 단위). */
  pay_amount?: number | null;
  /** 공고별 AI 참고 정보 (근무·차량 정책 등 자유 기재) — branches.ai_facts의 공고 레벨 미러. */
  ai_facts?: string | null;
  /** 모집 방식 (external/internal/both) — internal 실공고는 일반 라인 스크리닝 흐름을 탄다. */
  recruit_mode?: string | null;
  /** 공고 상태 — 라우터가 실질 마감(isJobEffectivelyClosed) 판단에 사용. */
  status?: string | null;
  /** 마감시각 — status='active'여도 지났으면 실질 마감. */
  closes_at?: string | null;
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
  status: string | null;
  baemin_id: string | null;
}

export interface ConversationTurn {
  direction: "inbound" | "outbound";
  body: string;
  created_at: string;
}

/**
 * 멀티-잡 인지(Phase 1)용 — 이 지원자가 '현재 공고' 외에 동시에 진행 중인 다른 공고들의 요약.
 * 에이전트가 다른 공고 문의를 현재 공고 정보로 잘못 답하지 않게 하는 컨텍스트.
 */
export interface OtherActiveJob {
  job_id: number;
  title: string;
  branch: string | null;
  stage: StageName;
}

export interface StageContext {
  job: JobContext | null;       // 매칭된 공고 (active 단계 등에선 null 가능)
  applicant: ApplicantContext;
  history: ConversationTurn[];  // 시간순 (오래된 → 최근), 본 인입 제외
  state: AgentState;
  /** 이 지원자가 동시에 진행 중인 '다른' 공고들. 비어있으면 단일 공고(기존과 동일). */
  otherActiveJobs?: OtherActiveJob[];
  /** 현재 공고가 실질 마감 상태 — 일반 라인 스크리닝이 '마감 안내 모드'(신규 진행 대신
   *  충원완료 안내 + 결원 시 우선 안내 약속 + 선탑 전환)로 동작하는 근거. */
  jobClosed?: boolean;
}

export type StageTransition =
  | { kind: "stay" }
  | { kind: "advance"; to: StageName; reason: string }
  // 에이전트가 pause 시 인계 사유를 구조화해 함께 넘긴다(P1a). category/suggestedAction은 선택.
  | { kind: "pause"; reason: string; category?: string; suggestedAction?: string }
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
