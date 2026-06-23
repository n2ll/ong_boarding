/**
 * 인계(paused) 사유 → 카테고리.
 *
 * 두 경로로 채워진다:
 *  1) (정확) 에이전트가 pause를 결정할 때 handoff_category·suggested_action을 직접 emit → meta.pause에 저장.
 *  2) (폴백) 매니저 수동 pause나 구버전 데이터는 paused_reason 텍스트를 키워드로 추정 분류(classifyHandoff).
 *
 * tone:
 *  - urgent     : 즉시 대응 권장(컴플레인 등)
 *  - answerable : 정보만 채우면 자동화 가능 영역(단가·정산 등) — 공고 필드化 후보
 *  - human      : 사람이 직접 처리(통화·계약 등)
 *  - neutral    : 일반 인계
 */

export type HandoffTone = "urgent" | "answerable" | "human" | "neutral";

export interface HandoffCategory {
  id: string;
  label: string;
  tone: HandoffTone;
  /** 실무자용 추천 액션 한 줄(카테고리 기본값) — 에이전트 emit이 있으면 그걸 우선 사용 */
  action: string;
}

// 모든 카테고리의 단일 소스(라벨·톤·기본 추천 액션).
const CATEGORY_META: Record<string, { label: string; tone: HandoffTone; action: string }> = {
  pay: { label: "단가·정산", tone: "answerable", action: "공고에 수치 없음 → 확인 후 안내" },
  contract: { label: "계약·고용", tone: "human", action: "계약·보험 매니저 영역 → 직접 응대" },
  call: { label: "통화·연락요청", tone: "human", action: "통화 연결 / 연락 일정 안내" },
  tech: { label: "기술·온보딩", tone: "human", action: "앱·온보딩 직접 지원" },
  complaint: { label: "컴플레인", tone: "urgent", action: "긴급 — 매니저 직접 응대 권장" },
  capacity: { label: "티오·물량", tone: "human", action: "티오·물량 현황 확인 후 안내" },
  cross_job: { label: "교차공고", tone: "human", action: "다른 공고 건 → 해당 담당 확인 후 안내" },
  policy: { label: "기타·정책", tone: "human", action: "공고 미명시 정책 → 확인 후 안내" },
  // 아래 3개는 에이전트가 고르지 않고, 매니저/시스템 pause·분류 폴백에서만 쓰인다.
  manual: { label: "수동(매니저)", tone: "neutral", action: "확인 후 AI 재개" },
  auto: { label: "자동인계", tone: "neutral", action: "확인 후 AI 재개" },
  unknown: { label: "사유 미상", tone: "neutral", action: "내용 확인 필요" },
};

/** 에이전트가 pause 시 직접 고를 수 있는 카테고리(수동/자동/미상 제외). */
export const AGENT_CATEGORY_IDS = [
  "pay",
  "contract",
  "call",
  "tech",
  "complaint",
  "capacity",
  "cross_job",
  "policy",
] as const;

/** id → 카테고리. 미지의 id면 unknown. */
export function getCategory(id: string | null | undefined): HandoffCategory {
  const key = id && CATEGORY_META[id] ? id : "unknown";
  return { id: key, ...CATEGORY_META[key] };
}

// 키워드 폴백 분류 — paused_reason 텍스트에서 첫 매칭.
const RULES: { re: RegExp; id: string }[] = [
  { re: /취소|법적|불만|호소|항의/, id: "complaint" },
  { re: /다른\s*공고|교차/, id: "cross_job" },
  { re: /단가|시급|프로모션|페이|배송비|임금|정산|수입|수당|급여|주급/, id: "pay" },
  { re: /계약|보험|고용형태|일용직|4대|풀타임|자영업|세금/, id: "contract" },
  { re: /통화|전화|연락\s*(요청|예정|시점|가능)|상담\s*요청/, id: "call" },
  { re: /교육|영상|소리|앱|가입|번호|아이디|차량번호|커넥트/, id: "tech" },
  { re: /티오|자리\s*여부|재게재|배차|수량|건수|티/, id: "capacity" },
  { re: /수동\s*일시정지/, id: "manual" },
  { re: /자동\s*인계|직접\s*응답/, id: "auto" },
];

/** paused_reason 텍스트를 카테고리로 분류(폴백). 첫 매칭 우선, 미매칭은 policy. */
export function classifyHandoff(reason: string | null | undefined): HandoffCategory {
  const r = (reason ?? "").trim();
  if (!r) return getCategory("unknown");
  for (const { re, id } of RULES) {
    if (re.test(r)) return getCategory(id);
  }
  return getCategory("policy");
}

// ─────────────────────────────────────────────────────────────
// 에이전트 stage tool 연동 (P1a) — pause 시 카테고리·추천액션을 직접 emit
// ─────────────────────────────────────────────────────────────

/** 각 stage의 *_turn tool input_schema.properties에 그대로 spread. */
export const handoffToolProperties = {
  handoff_category: {
    type: "string" as const,
    enum: [...AGENT_CATEGORY_IDS],
    description:
      "transition이 pause일 때만 채워라. 인계 사유의 성격: pay(단가·정산)/contract(계약·고용)/call(통화·연락요청)/tech(기술·온보딩)/complaint(컴플레인·항의)/capacity(티오·물량)/cross_job(다른 공고 문의)/policy(공고 미명시 기타 정책). pause가 아니면 생략.",
  },
  suggested_action: {
    type: "string" as const,
    description:
      "transition이 pause일 때만 채워라. 매니저가 무엇을 하면 되는지 한 줄(예: '건당 단가 공고 미명시 → 확인 후 회신', '통화 연결 필요'). pause가 아니면 빈 문자열.",
  },
};

/** 각 stage 시스템 프롬프트에 append하는 인계 분류 규칙. */
export const HANDOFF_EMIT_RULE = `
## 인계(pause) 시 분류 — transition을 pause로 정했으면 아래 둘을 함께 채워라
- handoff_category: pay / contract / call / tech / complaint / capacity / cross_job / policy 중 하나
- suggested_action: 매니저가 바로 무엇을 하면 되는지 한 줄(지원자 질문 맥락 반영). 예) "건당 단가는 공고 미명시 → 확인 후 회신", "본인이 직접 통화 요청 → 연락"
- ⚠️ pause가 아니면 둘 다 비워라.`;
