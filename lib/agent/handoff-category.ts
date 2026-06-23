/**
 * 인계(paused) 사유 → 카테고리 분류.
 *
 * job_candidates.paused_reason은 에이전트/매니저가 자유 텍스트로 남긴다(현재 45종).
 * 매니저가 작업 큐에서 "어떤 성격의 인계인지" 한눈에 보도록 읽기 시점에 카테고리로 묶는다.
 * (P1에서 에이전트가 코드로 직접 emit하게 되면 이 분류기는 폴백으로만 쓰인다.)
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
}

const RULES: { re: RegExp; cat: HandoffCategory }[] = [
  { re: /취소|법적|불만|호소|항의/, cat: { id: "complaint", label: "컴플레인", tone: "urgent" } },
  { re: /다른\s*공고|교차/, cat: { id: "cross_job", label: "교차공고", tone: "human" } },
  { re: /단가|시급|프로모션|페이|배송비|임금|정산|수입|수당|급여|주급/, cat: { id: "pay", label: "단가·정산", tone: "answerable" } },
  { re: /계약|보험|고용형태|일용직|4대|풀타임|자영업|세금/, cat: { id: "contract", label: "계약·고용", tone: "human" } },
  { re: /통화|전화|연락\s*(요청|예정|시점|가능)|상담\s*요청/, cat: { id: "call", label: "통화·연락요청", tone: "human" } },
  { re: /교육|영상|소리|앱|가입|번호|아이디|차량번호|커넥트/, cat: { id: "tech", label: "기술·온보딩", tone: "human" } },
  { re: /티오|자리\s*여부|재게재|배차|수량|건수|티/, cat: { id: "capacity", label: "티오·물량", tone: "human" } },
  { re: /수동\s*일시정지/, cat: { id: "manual", label: "수동(매니저)", tone: "neutral" } },
  { re: /자동\s*인계|직접\s*응답/, cat: { id: "auto", label: "자동인계", tone: "neutral" } },
];

const FALLBACK: HandoffCategory = { id: "other", label: "기타·정책", tone: "human" };

/** paused_reason 텍스트를 카테고리로 분류. 첫 매칭 우선. */
export function classifyHandoff(reason: string | null | undefined): HandoffCategory {
  const r = (reason ?? "").trim();
  if (!r) return { id: "unknown", label: "사유 미상", tone: "neutral" };
  for (const { re, cat } of RULES) {
    if (re.test(r)) return cat;
  }
  return FALLBACK;
}
