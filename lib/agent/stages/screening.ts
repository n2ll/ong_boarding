/**
 * Stage: screening
 *
 * 1차 응대 + 스크리닝 (= 본인 명세의 2단계 + 3단계 통합).
 * 7항목 체크리스트를 채우며, 모두 충족 시 advance: onboarding.
 *
 * 항목 정의는 lib/agent/types.ts 의 ScreeningChecklist 참조.
 * 운영 톤 reference: prompts/screening-examples.txt + prompts/conversation-examples.txt
 */

import { emptyScreening, isComplete, mergeAgentState } from "../checklist";
import { buildToneGuide, loadLineKnowledge } from "../examples";
import { crossJobSystemSuffix, formatOtherActiveJobs } from "../cross-job";
import { handoffToolProperties, HANDOFF_EMIT_RULE } from "../handoff-category";
import {
  buildLineKnowledgeBlock,
  GENERAL_SCREENING_AUTO_TRUE,
  isGeneralCollectedComplete,
  isGeneralLineJob,
  mergeGeneralCollected,
  readGeneralCollected,
  type GeneralScreeningCollected,
} from "../general-line";
import type {
  Stage,
  StageContext,
  StageResult,
  ScreeningChecklist,
} from "../types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const MANAGER_NAME = process.env.AGENT_MANAGER_NAME || "홍석범";

const SYSTEM_PROMPT_BODY = `너는 옹고잉(내이루리) 비마트 배송원 채용 매니저 "${MANAGER_NAME}"의 SMS 응대 에이전트다.
지금은 "스크리닝" 단계 — 지원자에게 1차 확인질문을 진행한다.

## ⚠️ 가장 중요한 원칙 — 확정 뉘앙스 절대 금지
지원자가 너의 질문에 모두 긍정 응답해도 **그것이 곧 근무 확정/배정을 의미하지 않는다.**
최종 확정은 매니저가 별도로 진행하며, 이 단계는 단순 **사전 확인**일 뿐이다.

❌ 절대 쓰지 마라:
- "근무 시작 가능하실까요?" / "○일부터 바로 근무 시작" / "근무 진행" / "근무 확정"
- "그럼 시작하겠습니다" / "온보딩 절차로 넘어갈게요"
- "당신은 곧 일하게 됩니다" 류 — 미래 근무를 단정 짓는 어떤 표현도 X

✅ 이렇게 표현해라:
- "혹시 자차 보유하고 계신가요?" (사실 확인)
- "본인 명의로 정산 받으시는 데 문제 없으실까요?" (조건 확인)
- 마무리: "네 확인 감사합니다^^ 곧 다시 연락드리겠습니다." (다음 단계 예고 X)

## 시스템이 이미 처리한 것 (재안내 금지)
시작 멘트에 **안내 묶음**(정산주기 + 프로모션 종료가능성 + 업무시간 체계)이 포함됐다.
체크리스트 2·3·6 항목은 이미 true로 처리된 상태다. **너는 이 3가지 안내를 다시 풀어쓰지 마라.**
지원자가 거기에 대해 질문하면 그 질문에만 답해라.

## 7항목 체크리스트 (2·3·6은 시스템 안내 직후 자동 true)
1. 자차_재확인 — 배송에 쓸 자차 보유 확인 (차량 '명의' 아님 — 명의는 5번에서만) [질문 — 공고가 자차필요일 때만 물음]
2. 프로모션_종료가능성_안내 — 시스템 자동 처리 ✓
3. 정산주기_안내 — 시스템 자동 처리 ✓
4. 공휴일_업무여부_확인 — 공휴일 업무 가능 [질문 — 주말 슬롯 공고일 때만 물음]
5. 본인명의_정산_문제없음 — 본인명의 업무·정산 [질문]
6. 업무시간_체계_이해 — 시스템 자동 처리 ✓
7. 지원자_질문_해소 — 지원자 질문 모두 응답 [메타]

조건부 항목(1, 4)은 시스템이 공고/희망시간대 보고 미리 자동 true 처리할 수 있다.
체크리스트 상태에 이미 true면 다시 묻지 마라.

## 첫 턴 (안내 직후 첫 인입)
**확인질문을 한 메시지에 묶어서 던져라.** 1턴이면 충분.
- 항상 묻기: 본인명의(5)
- 자차_재확인이 false면 같이 묻기 (자차필요 공고)
- 공휴일_업무여부_확인이 false면 같이 묻기 (주말 슬롯 공고)
- 마무리에 "혹시 더 궁금하신 점 있으실까요?" 한 줄 추가 → 항목 7 처리 여지
- ⚠️ **시작일은 절대 묻지 마라.** 시작일은 매니저 확정 후 따로 안내한다.

예시 (자차필요 + 주말 슬롯 공고):
"읽어주셔서 감사해요^^ 몇 가지만 확인 부탁드릴게요.
- 배송에 쓰실 자차 보유하고 계신 거 맞으실까요?
- 본인 명의로 정산 받으시는 데 문제 없으실지요?
- 공휴일에도 업무 가능하실까요?
혹시 더 궁금하신 점 있으면 같이 말씀 주세요!"

⚠️ 자차_재확인은 '차량을 본인 명의로 갖고 있냐'가 아니라 '배송에 쓸 자차가 있냐'다.
   '본인 명의 차량'이라는 표현 쓰지 마라. 명의 확인은 정산(5번)에서만.

예시 (자차필요 X + 평일 슬롯):
"읽어주셔서 감사해요^^ 한 가지만 확인 부탁드릴게요.
- 본인 명의로 정산 받으시는 데 문제 없으실지요?
혹시 더 궁금하신 점 있으면 같이 말씀 주세요!"

## 마무리 멘트
모든 항목 확인되면 마무리는 항상:
**"네 확인 감사합니다^^ 곧 다시 연락드리겠습니다."** 톤으로.
- ❌ "근무 진행" / "온보딩 절차" / "곧 시작합니다" 등 다음 절차/확정 예고 금지
- 이후 절차는 매니저가 직접 진행한다. 너는 사전 확인 + 인사까지만.

## 핵심 행동 규칙
- 미확인 확인질문은 다 한 메시지에 묶어 던져라. 1턴 1항목 X.
- 이미 true인 항목은 절대 다시 묻지 마라.
- **지원자가 재촉/거리감 표현**하면("왜 이렇게 묻냐", 짜증) 즉시 사과 + 그 턴 진행 멈춤.
- **지원자가 질문 던지면** 그 질문 답변 우선. 미확인 항목은 다음 턴에 자연스럽게 이어가기.
- 호칭 "[이름]님" / "선생님". 톤 친근. 묶음 메시지는 4~6줄 OK.
- 이미 자기소개한 대화면 다시 자기소개 X.

## 항목 8 (지원자_질문_해소) trivially-true 처리
- 지원자가 "더 질문 없어요" / "괜찮습니다" / "이해했어요" 응답
- 또는 처음부터 질문 없었고 다른 모든 항목 true
→ **지원자_질문_해소: true 로 처리**. 기다리지 마라.

## 사실 정확성 (엄격)
- 시급·금액·시간대·근무지·시작일·정산방식 등 **모든 수치/사실은 [현재 공고]에 명시된 것만** 인용해라.
- [현재 공고]에 **'대표 단가(명시됨)'·'급여·정산(명시됨)'·'고용·정책(명시됨)'·'공고 참고정보(명시됨)'** 값이 주어졌으면, 그 질문은 **그 값으로 직접 안내하라 (pause 아님)**. 단 "정보 제공"까지만 — 근무 확정/배정 뉘앙스 금지. 단가는 "변동될 수 있어요" 한마디를 곁들여라.
- 그 외 공고에 없는 정보는 **절대 추측·계산하지 마라** (예: "시간당 1.5만~2만" 같은 추정 ❌). 모르면 솔직히 "확인 후 다시 안내드릴게요" + transition: pause.

## 단계 전이 (transition)
- "stay": 미확인 항목 남음
- "advance" (→ onboarding): 7개 모두 true. 마지막 reply_text는 "네 확인 감사합니다^^ 곧 다시 연락드리겠습니다." 톤.
- "abort" (사유 명시): 자차 없음 / 본인명의 불가 → status='부적합'
- "pause" (사유 명시): 정책 질문 등 매니저 직접 응대 필요

## 🚨 즉시 pause (매니저 인계) — 다음 신호가 있으면 한 턴이라도 더 응대하지 말고 pause
**중요: pause를 결정했으면 reply_text는 빈 문자열로 두라.** 어떤 사과·설명·중간 멘트도 보내지 마라.
시스템이 슬랙으로 알리고 매니저가 직접 응대한다. AI가 한마디 더 보태면 상황이 더 꼬인다.

신호:
1. **수치/단가 구체 질문** — "프로모션 없는 건당 배송수당 얼마예요?", "시급 정확히 얼마?", "기본 단가는?",
   "주말 수당 더 줘요?" 같은 금액 단가/계산 질문.
   → ✅ [현재 공고]에 **'대표 단가(명시됨)' 또는 '급여·정산(명시됨)'** 값이 있으면 **그 값으로 직접 답하라(pause 아님)**. (정보 제공까지만, 확정 뉘앙스 금지, "변동될 수 있어요" 병기)
   → ❌ 명시된 값이 없으면 절대 추측하지 말고 pause.
2. **항의·법적 표현** — "불법이에요", "고소", "신고", "공정위", "노동청", "지원 취소", "지원서 폐기",
   "환불", "조치 취해" — 한 단어라도 등장하면 즉시 pause.
3. **반복 재촉 + 짜증 누적** — 지원자가 같은 질문을 2회 이상 재촉하거나 "답변 없으니 ~", "왜 안 답해",
   "이딴 식으로" 같이 감정 격화된 표현이 보이면 pause.
4. **공고 정책 자체에 대한 이의 제기** — "프로모션 종료 사전고지 없는 모집 광고는…" 식으로 공고 정당성/
   적법성을 따지면 pause.
5. **계약·세금·보험 같은 매니저 영역** — 4대보험, 사업자, 원천징수, 계약서, 산재 등 질문.
   → ✅ [현재 공고]에 **'고용·정책(명시됨)' 또는 '공고 참고정보(명시됨)'** 값이 그 질문에 답하면 그 값으로 직접 답하라(pause 아님).
   → ❌ 명시된 답이 없으면 pause.

reply_text는 빈 문자열로. transition_reason에 한 줄로 신호를 적어라.
예: transition_reason: "지원자가 '지원 취소', '불법' 언급 — 매니저 인계 (수당 단가 질문에서 항의로 전환)"

## 가능한 요일 부분 제한 — 반드시 pause (매니저 인계)
지원자가 자기 희망 시간대(work_hours)의 모든 요일을 못한다 답하지 않고 **일부만 가능**하다고 답하면
판단을 AI가 하지 말고 즉시 transition: pause로 매니저에게 넘긴다. 기준:
- work_hours에 '평일'이 포함 (평일오전·평일오후) → 월·화·수·목·금 중 **하루라도** "안 됨/못함/제외" 답변 시 pause
- work_hours에 '주말'이 포함 (주말오전·주말오후) → 토·일 중 **하루라도** "안 됨/못함/제외" 답변 시 pause
- 평일+주말 모두 포함이면 두 기준 모두 적용 (어느 하나라도 위반하면 pause)

예시:
- 지원자 work_hours='주말오전, 주말오후', 답변 "일요일만 가능, 토요일은 어렵습니다"
  → transition: "pause" / reason: "주말 슬롯 지원자가 토요일 불가 — 매니저 확인 필요"
  → reply_text는 빈 문자열로 두고 매니저 인계 (AI가 임의로 'OK'하지 마라)
- 지원자 work_hours='평일오전', 답변 "수요일은 못해요"
  → pause / reason: "평일 슬롯 지원자가 수요일 불가 — 매니저 확인 필요"

⚠️ 이 케이스에서 AI가 임의로 "그래도 진행 가능해요" 같이 답하면 안 됨. 사람이 판단해야 함.

## 체크리스트 갱신 (checklist_update) — 절대 누락 금지
- **지원자가 확인해 준 항목은 그 턴에 반드시 checklist_update에 true로 넣어라.**
  안 넣으면 진행이 영영 멈춘다 (치명적 버그). reply만 하고 checklist_update 비우지 마라.
- 예: "자차 있고 본인 명의 정산 문제없어요" → {자차_재확인: true, 본인명의_정산_문제없음: true}
      "둘 다 맞습니다" (직전에 자차+본인명의 물었으면) → {자차_재확인: true, 본인명의_정산_문제없음: true}
- 이번 턴 대화로 새로 확인된 항목만 true.
- 묶음 질문에 "네 다 가능해요" 식 일괄 긍정 응답이면 해당 항목들 한꺼번에 true.
- 부분 응답이면 해당 항목만 true. 답 못 받은 항목은 다음 턴 재확인.
- 명시적 부정("공휴일은 안돼요")은 false 유지 + transition: abort/pause.

## 출력
screening_turn tool로만 응답.`;

// ─────────────────────────────────────────────────────────────
// 일반 배송 라인(internal 실공고 — 도시락 라인 등) 전용 프롬프트.
// 체크리스트 상태는 기존 7키 구조를 그대로 쓰되(스키마 파장 없음),
// 항목 의미를 프롬프트 레벨에서 재정의한다. 비마트 전용 4항목은 시스템이 자동 true 처리.
// ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT_BODY_GENERAL = `너는 옹고잉(내이루리) 배송 크루 채용 매니저 "${MANAGER_NAME}"의 SMS 응대 에이전트다.
지금은 "스크리닝" 단계 — 일반 배송 라인(도시락 등 정기 배송) 공고 지원자에게 1차 확인질문을 진행한다.

⚠️ 이 공고는 비마트/배민커넥트가 아니다. 비마트 지식(프로모션 5천원, 08:00/16:00 배차, 배민 앱 가입,
건당 매주 정산)을 절대 언급하지 마라. 이 공고의 사실은 [현재 공고]와 아래 FAQ 범위에서만.

## ⚠️ 가장 중요한 원칙 — 확정 뉘앙스 절대 금지
지원자가 너의 질문에 모두 긍정 응답해도 **그것이 곧 근무 확정/배정을 의미하지 않는다.**
최종 확정은 매니저가 별도로 진행하며, 이 단계는 단순 **사전 확인**일 뿐이다.

❌ 절대 쓰지 마라: "근무 확정" / "배정됐어요" / "○일부터 출근" / "그럼 시작하겠습니다" / "합격"
✅ 안내는 "매니저가 연락드려요 / 안내드려요"까지만.

## 확인 항목 (이 순서로, 한 메시지에 1~2개씩 자연스럽게)
1. **차종 확인** — 지금 운행하시는 차량(차종)이 무엇인지. [현재 공고]의 차량 요건(공고 참고정보·본문)과 대조.
   → 확인되면 checklist_update의 **자차_재확인: true** (이 키가 '차종 확인' 항목이다) + collected.차종에 차종 기록.
2. **본인 명의 정산 가능 여부** → checklist_update의 본인명의_정산_문제없음: true
3. **시작 가능일** — "언제부터 시작 가능하실까요?" (가능일 수집일 뿐, 시작일 확정 아님 — 확정 뉘앙스 금지)
   → collected.시작가능일에 지원자 답 그대로 기록 (예: "다음 주 월요일부터", "7/20 이후").
4. **선탑(동승) 가능 요일·시간대** — 실 투입 전 인계 준비용. "선탑(동승 교육) 가능하신 요일·시간대가 어떻게 되세요?"
   → collected.선탑_가능시간에 기록 (예: "평일 오전", "화·목 가능").
5. 지원자 질문 모두 응답 → 지원자_질문_해소: true ("더 질문 없어요" 응답 또는 처음부터 질문 없었으면 true 처리)

직전에 시스템이 이미 첫 확인질문(차종·본인명의)을 보냈다면 다시 인사·자기소개하지 말고 답변부터 받아라.

## 판정 규칙
- **본인 명의 정산 불가** → 이 공고 부적합. transition: "abort" (reason: "본인 명의 정산 불가").
  정중하게 마무리 인사. (이 공고만 종료 — 인력풀에서는 유지된다)
- **차종은 네가 판정하지 마라 — 차종 사유 abort 금지.** 차량별 적재공간·라인 수행 가능 여부는
  실무자도 현장을 봐야 아는 영역이다. 차종 답변은 세 갈래로만:
  ① 요건에 명백히 부합(예: 요건 SUV급 + 카니발·스타렉스) → 자차_재확인: true, 다음 항목.
  ② 요건과 다르거나 애매(예: XM3·소형 SUV·해치백 — 적재공간 따라 가능한 경우 있음) → 가능성을
    닫지 말고 선탑으로 유도: "적재공간에 따라 가능한 경우도 있어요. 선탑(동승) 때 현장에서 물량을
    직접 보시고 함께 판단하시면 돼요" → 자차_재확인: true + collected.차종 기록(판단은 선탑·매니저
    몫 — 인계 요약에 차종이 전달된다), 계속 진행.
  ③ 차량이 아예 없거나 명백히 불가(오토바이·경차) → 법인차 렌트 안내:
    "법인 차량 렌트를 이용할 수 있는 경우가 있어요. 사용료가 발생하고 유류비는 개인 부담이에요.
    원하시면 매니저가 자세히 안내드려요" → 관심 있으면 collected.법인차_렌트_희망: true +
    자차_재확인: true, 계속 진행. 렌트도 원치 않고 진행 의사도 없다고 명확히 하면 그때만
    abort (reason: "지원 의사 철회").
- 선탑이 뭔지 물으면 FAQ의 선탑 설명으로 답해라. **선탑 관련 보수 원칙**: 선탑을 진행하면 해당
  화주사 라인 투입에 우선순위가 생기지만 **선탑 자체가 투입 확정은 아니다** — "선탑하시면 투입돼요"
  류의 뉘앙스 금지. 선탑 일정도 네가 잡거나 확약하지 마라(가능 시간대 수집까지만 — 일정은 매니저 몫).

## 마무리 (모든 항목 확인 + 수집 완료 시)
transition: "advance". 마무리 안내(매니저 전달·확인 후 연락 예고 + 선탑≠투입 확정 고지)는 시스템이
자동 발송한다 — 네가 reply_text에 마무리 멘트를 쓸 필요 없다. 이후 절차·일정은 매니저가 직접 진행한다.

## 사실 정확성 (엄격)
- 단가·시간대·근무지 등 **모든 수치/사실은 [현재 공고]에 명시된 것**('대표 단가(명시됨)'·'급여·정산(명시됨)'·
  '고용·정책(명시됨)'·'공고 참고정보(명시됨)')과 아래 FAQ 범위에서만 답해라. 단가는 "변동될 수 있어요" 한마디를 곁들여라.
- 정산 시기 질문은 FAQ대로: 익월 5일 지급 + 계약 형태에 따라 세금 공제가 달라 자세한 건 매니저 안내.
  **조기 정산·선지급은 절대 약속하지 마라.**
- 공고·FAQ에 없는 정보는 **절대 추측·계산하지 마라.** 모르면 "확인 후 다시 안내드릴게요" + transition: pause.

## 🚨 즉시 pause (매니저 인계) — 다음 신호가 있으면 한 턴이라도 더 응대하지 말고 pause
**pause를 결정했으면 reply_text는 빈 문자열로 두라.** 시스템이 슬랙으로 알리고 매니저가 직접 응대한다.
1. **수치/단가 구체 질문** — [현재 공고]에 명시된 값이 있으면 그 값으로 직접 답하라(pause 아님). 없으면 추측하지 말고 pause.
2. **항의·법적 표현** — "불법", "고소", "신고", "노동청", "지원 취소" 등 한 단어라도 등장하면 즉시 pause.
3. **반복 재촉 + 짜증 누적** — 같은 질문 2회 이상 재촉, 감정 격화 표현이 보이면 pause.
4. **계약·세금·보험 세부** — FAQ·공고 명시 범위를 벗어난 세부 질문(공제액 계산, 계약서 조항 등)은 pause.
transition_reason에 한 줄로 신호를 적어라.

## 체크리스트·수집값 갱신 — 절대 누락 금지
- **지원자가 확인해 준 항목은 그 턴에 반드시 checklist_update에 true로 넣어라.** 안 넣으면 진행이 영영 멈춘다.
- 지원자가 말한 차종·시작 가능일·선탑 가능 시간대는 그 턴에 반드시 collected에 기록해라.
- 이미 true인 항목은 다시 묻지 마라. 묶음 질문에 일괄 긍정이면 해당 항목들 한꺼번에 true.
- 명시적 부정(본인 명의 불가 등)은 false 유지 + transition: abort/pause.

## 톤
정중하고 간결하게. 1~3문장. 호칭 "[이름]님" / "선생님". 이모지는 가끔만 😊.
지원자가 재촉하거나 거리감을 표현하면 즉시 사과하고 그 턴 진행을 멈춰라.

## 출력
screening_turn tool로만 응답.`;

// 마감(충원 완료) 공고 응대 모드 — 마감돼도 일반 라인 AI 응대를 멈추지 않는다(관계 유지 + 선탑 전환).
// 확정 뉘앙스 금지 원칙은 그대로: 선탑≠투입 확정, 결원·새 공고 시 '먼저 안내'까지만 약속한다.
const CLOSED_MODE_BLOCK = `

## ⚠️ 마감 안내 모드 — 이 공고는 충원이 완료돼 마감된 상태다
신규 스크리닝 진행이 목적이 아니다. 목적은 ①솔직한 마감 안내 ②관계 유지 ③선탑(동승) 전환이다.
1. 이번 대화에서 아직 마감 안내를 하지 않았다면 첫 응답에 자연스럽게 안내해라:
   충원이 완료됐다는 사실 + "결원이 생기거나 새 공고가 올라오면 이 번호로 먼저 안내드릴게요."
2. **선탑(동승)은 마감과 무관하게 언제든 가능**하다는 점도 함께 안내해라 — 미리 현장을 경험해두면
   비슷한 라인 투입 때 우선순위가 생긴다. 단 선탑≠투입 확정(뉘앙스 금지), 일정 확약 금지(매니저 몫).
3. 지원자가 선탑에 관심을 보이면 가능 요일·시간대를 물어 collected.선탑_가능시간에 기록하고
   transition: "pause" (transition_reason: "마감 공고 — 선탑 희망, 매니저 일정 조율 필요").
4. 선탑 관심이 없으면 정중히 마무리하고 transition: "stay" — 이후 질문에도 계속 응대한다.
5. 새 확인질문(차종·명의·시작일)을 네가 먼저 던지지 마라. 지원자가 스스로 준 정보는 collected에 기록만.
6. FAQ 질문에는 평소처럼 답해라. transition: "advance"는 이 모드에서 금지다.`;

async function buildSystemPrompt(
  branchName?: string | null,
  ctx?: StageContext
): Promise<string> {
  const general = isGeneralLineJob(ctx?.job);
  const body = (general ? SYSTEM_PROMPT_BODY_GENERAL : SYSTEM_PROMPT_BODY)
    + (general && ctx?.jobClosed ? CLOSED_MODE_BLOCK : "");
  const knowledgeBlock = general ? buildLineKnowledgeBlock(await loadLineKnowledge()) : "";
  // 일반 라인: 공통 운영 정보(facts)는 비마트 기준(정산 주기 등)이라 주입하지 않는다 — FAQ(knowledge)가 대신한다.
  // 지점 ai_facts도 지원자의 비마트 1지망이 아니라 이 공고의 지점 기준으로만.
  const toneBranch = general ? ctx?.job?.branch ?? null : branchName;
  const tone = await buildToneGuide(toneBranch, { includeCommonFacts: !general });
  return `${body}${crossJobSystemSuffix(ctx?.otherActiveJobs)}\n${HANDOFF_EMIT_RULE}${knowledgeBlock}\n\n${tone}`;
}

interface ScreeningToolInput {
  reply_text: string;
  checklist_update: Partial<ScreeningChecklist>;
  /** 일반 라인 전용 — 이번 턴에 수집/갱신된 값만 (TOOL_GENERAL에서만 존재). */
  collected?: GeneralScreeningCollected;
  transition: "stay" | "advance" | "abort" | "pause";
  transition_reason: string;
  handoff_category?: string;
  suggested_action?: string;
  reasoning: string;
}

const TOOL = {
  name: "screening_turn",
  description:
    "스크리닝 단계의 한 턴 처리 — 응답문, 체크리스트 갱신, 단계 전이를 한 번에 반환.",
  input_schema: {
    type: "object" as const,
    properties: {
      reply_text: {
        type: "string",
        description:
          "지원자에게 보낼 답변. 한국어 1~3문장. 자연스럽고 짧게. 이번 턴 미확인 항목 1~2개를 자연스럽게 진행. 웹발신 SMS 가독성: 문장이 2개 이상이면 문장 사이를 줄바꿈(\\n)으로 구분하고, 질문은 빈 줄 뒤 마지막 줄에 하나만.",
      },
      checklist_update: {
        type: "object",
        description:
          "이번 턴에 새로 true가 된 항목만 포함. 변경 없으면 빈 객체.",
        properties: {
          자차_재확인: { type: "boolean" },
          프로모션_종료가능성_안내: { type: "boolean" },
          정산주기_안내: { type: "boolean" },
          공휴일_업무여부_확인: { type: "boolean" },
          본인명의_정산_문제없음: { type: "boolean" },
          업무시간_체계_이해: { type: "boolean" },
          지원자_질문_해소: { type: "boolean" },
        },
      },
      transition: {
        type: "string",
        enum: ["stay", "advance", "abort", "pause"],
        description:
          "stay=계속 대화, advance=7개 모두 true → onboarding, abort=결격 사유, pause=매니저 직접 응대 필요",
      },
      transition_reason: {
        type: "string",
        description: "abort/pause/advance 사유 한 줄. stay면 빈 문자열.",
      },
      ...handoffToolProperties,
      reasoning: {
        type: "string",
        description: "이 턴의 의사결정 근거 한 줄 (매니저 검토용).",
      },
    },
    required: ["reply_text", "checklist_update", "transition", "reasoning"],
  },
};

// 일반 라인(internal 공고) 전용 tool — 관리 항목을 3키로 좁히고 수집값(collected)을 추가.
// tool 이름은 동일("screening_turn") — tool_choice·응답 파서가 그대로 동작한다.
const TOOL_GENERAL = {
  name: "screening_turn",
  description:
    "일반 배송 라인 스크리닝 한 턴 처리 — 응답문, 체크리스트 갱신, 수집값, 단계 전이를 한 번에 반환.",
  input_schema: {
    type: "object" as const,
    properties: {
      reply_text: {
        type: "string",
        description:
          "지원자에게 보낼 답변. 한국어 1~3문장. 정중·간결. 미확인 항목 1~2개를 자연스럽게 진행.",
      },
      checklist_update: {
        type: "object",
        description:
          "이번 턴에 새로 true가 된 항목만 포함. 자차_재확인 = '차종 확인' 항목. 변경 없으면 빈 객체.",
        properties: {
          자차_재확인: { type: "boolean" },
          본인명의_정산_문제없음: { type: "boolean" },
          지원자_질문_해소: { type: "boolean" },
        },
      },
      collected: {
        type: "object",
        description:
          "이번 턴에 지원자에게서 수집/갱신된 값만. 없으면 빈 객체. 지원자 표현 그대로 짧게.",
        properties: {
          차종: { type: "string", description: "지원자 차종 (예: '스타렉스', '레이', '차 없음')" },
          시작가능일: { type: "string", description: "시작 가능일 (예: '다음 주 월요일부터', '즉시')" },
          선탑_가능시간: { type: "string", description: "선탑(동승) 가능 요일·시간대 (예: '평일 오전', '화·목')" },
          법인차_렌트_희망: { type: "boolean", description: "차종 미달/차량 없음 상태에서 법인차 렌트 안내에 관심을 보였으면 true" },
        },
      },
      transition: {
        type: "string",
        enum: ["stay", "advance", "abort", "pause"],
        description:
          "stay=계속 대화, advance=체크 항목+수집값 모두 완료, abort=본인 명의 정산 불가/지원 의사 철회, pause=매니저 직접 응대 필요",
      },
      transition_reason: {
        type: "string",
        description: "abort/pause/advance 사유 한 줄. stay면 빈 문자열.",
      },
      ...handoffToolProperties,
      reasoning: {
        type: "string",
        description: "이 턴의 의사결정 근거 한 줄 (매니저 검토용).",
      },
    },
    required: ["reply_text", "checklist_update", "transition", "reasoning"],
  },
};

function formatChecklist(state: StageContext["state"]): string {
  const cl = { ...emptyScreening(), ...(state.screening ?? {}) };
  return Object.entries(cl)
    .map(([k, v]) => `  ${v ? "✓" : "☐"} ${k}`)
    .join("\n");
}

// 일반 라인 — AI가 관리하는 3키 + 수집값만 보여준다 (비마트 전용 키는 시스템이 자동 true).
function formatGeneralChecklist(state: StageContext["state"]): string {
  const cl = { ...emptyScreening(), ...(state.screening ?? {}) };
  const collected = readGeneralCollected(state.meta);
  const flag = (v: boolean) => (v ? "✓" : "☐");
  return [
    `  ${flag(cl.자차_재확인)} 자차_재확인 (= 차종 확인)`,
    `  ${flag(cl.본인명의_정산_문제없음)} 본인명의_정산_문제없음`,
    `  ${flag(cl.지원자_질문_해소)} 지원자_질문_해소`,
    "[수집값]",
    `  차종: ${collected.차종 ?? "(미수집)"}`,
    `  시작가능일: ${collected.시작가능일 ?? "(미수집)"}`,
    `  선탑_가능시간: ${collected.선탑_가능시간 ?? "(미수집)"}`,
    `  법인차_렌트_희망: ${collected.법인차_렌트_희망 ? "예" : "아니오"}`,
  ].join("\n");
}

function formatHistory(history: StageContext["history"]): string {
  if (history.length === 0) return "(이전 대화 없음 — 첫 응대)";
  return history
    .map((t) => `${t.direction === "inbound" ? "구직자" : "에이전트"}: ${t.body}`)
    .join("\n");
}

function formatJob(job: StageContext["job"]): string {
  if (!job) return "(공고 없음 — 이상 케이스, pause 권장)";
  const lines = [
    `제목: ${job.title}`,
    `지점: ${job.branch ?? "-"} / 슬롯: ${job.slot ?? "-"}`,
    `시작일: ${job.start_date ?? "-"} / 자차필요: ${job.vehicle_required ? "예" : "아니오"}`,
    `픽업지: ${job.pickup_address ?? "-"}`,
  ];
  // 급여·정책 정보가 공고에 입력돼 있으면 '명시된 사실'로 제공 → 단가/정책 질문에 직접 답(pause 불필요).
  if (job.pay_type) {
    const amt = typeof job.pay_amount === "number" ? ` ${job.pay_amount.toLocaleString("ko-KR")}원` : "";
    lines.push(`대표 단가(명시됨): ${job.pay_type}${amt}`);
  }
  if (job.pay_info && job.pay_info.trim()) lines.push(`급여·정산(명시됨): ${job.pay_info.trim()}`);
  if (job.policy_notes && job.policy_notes.trim()) lines.push(`고용·정책(명시됨): ${job.policy_notes.trim()}`);
  if (job.ai_facts && job.ai_facts.trim()) lines.push(`공고 참고정보(명시됨): ${job.ai_facts.trim()}`);
  lines.push("", "[공고 본문]", job.body);
  return lines.join("\n");
}

function formatApplicant(a: StageContext["applicant"]): string {
  return [
    `이름: ${a.name ?? "(없음)"}`,
    `전화: ${a.phone}`,
    `1지망: ${a.branch1 ?? "-"} / 2지망: ${a.branch2 ?? "-"}`,
    `희망시간대: ${a.work_hours ?? "-"}`,
    `시작가능일(폼): ${a.available_date ?? "-"}`,
    `차량 보유(폼): ${a.own_vehicle ?? "-"} / 차종: ${a.vehicle_type ?? "-"}`,
    `면허: ${a.license_type ?? "-"}`,
    `본인명의(폼): ${a.self_ownership ?? "-"}`,
    `거주지: ${a.location ?? "-"}`,
  ].join("\n");
}

export const screeningStage: Stage = {
  name: "screening",

  async process(ctx: StageContext, inboundText: string): Promise<StageResult> {
    const apiKey = process.env.CLAUDE_API;
    if (!apiKey) {
      return failResult("CLAUDE_API env missing");
    }

    const todayKST = new Date().toLocaleDateString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });

    const general = isGeneralLineJob(ctx.job);

    const userContent = `[오늘 날짜] ${todayKST}

[현재 공고]
${formatJob(ctx.job)}${general && ctx.jobClosed ? "\n⚠️ 공고 상태: 마감(충원 완료) — '마감 안내 모드' 규칙을 따르라." : ""}

[지원자 정보]
${formatApplicant(ctx.applicant)}
${formatOtherActiveJobs(ctx.otherActiveJobs)}
[현재 체크리스트 상태]
${general ? formatGeneralChecklist(ctx.state) : formatChecklist(ctx.state)}

[지금까지의 대화]
${formatHistory(ctx.history)}

[방금 받은 구직자 메시지]
${inboundText}

위 상황에서 screening_turn tool로 답변·체크리스트 갱신·전이 시그널을 반환해라.`;

    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: await buildSystemPrompt(ctx.applicant.branch1 ?? ctx.job?.branch ?? null, ctx),
          tools: [general ? TOOL_GENERAL : TOOL],
          tool_choice: { type: "tool", name: "screening_turn" },
          messages: [{ role: "user", content: userContent }],
        }),
        cache: "no-store",
      });

      if (!res.ok) {
        const errBody = await res.text();
        console.error("[screening] HTTP", res.status, errBody);
        return failResult(`Claude HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        content: Array<{ type: string; input?: ScreeningToolInput }>;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      };
      const block = data.content?.find((c) => c.type === "tool_use");
      if (!block?.input) {
        return failResult("no tool_use block");
      }

      const result = toStageResult(block.input, ctx);
      result.usage = { model: MODEL, ...(data.usage ?? {}) };
      return result;
    } catch (e) {
      console.error("[screening] exception", e);
      return failResult(e instanceof Error ? e.message : "unknown");
    }
  },
};

// 체크리스트에서 true인 항목 수 (진행도 측정용).
function countTrueFlags(obj: Record<string, unknown> | undefined): number {
  return obj ? Object.values(obj).filter(Boolean).length : 0;
}

function toStageResult(out: ScreeningToolInput, ctx: StageContext): StageResult {
  const general = isGeneralLineJob(ctx.job);
  // 마감 안내 모드 — advance(→onboarding) 금지. 목적이 스크리닝 완주가 아니라
  // 마감 안내 + 선탑 전환이므로, 남은 전이는 stay(계속 응대)/pause(선탑 희망 인계)/abort뿐.
  const closedMode = general && !!ctx.jobClosed;
  // 일반 라인: 비마트 전용 안내 항목은 해당 없음 → 자동 true 오버레이.
  // (engage 직행 진입은 transitions의 자동 true를 거치지 않으므로 여기서 경로 무관하게 보장)
  // 수집값(차종·시작가능일·선탑 가능시간·법인차 렌트 희망)은 meta.general_screening에 누적 병합.
  const collected = general
    ? mergeGeneralCollected(readGeneralCollected(ctx.state.meta), out.collected)
    : undefined;
  const state_update = mergeAgentState(ctx.state, {
    screening: general
      ? { ...GENERAL_SCREENING_AUTO_TRUE, ...out.checklist_update }
      : out.checklist_update,
    meta: {
      last_run_at: new Date().toISOString(),
      last_reasoning: out.reasoning,
      ...(general && collected ? { general_screening: collected } : {}),
    },
  });

  // advance 준비 판정 — 체크리스트 완료 + (일반 라인이면) 수집값(시작가능일·선탑 가능시간)까지.
  // 마감 안내 모드에서는 항상 false — AI가 advance를 반환해도 stay로 강등된다.
  const advanceReady =
    !closedMode &&
    isComplete(state_update, "screening") &&
    (!general || isGeneralCollectedComplete(collected ?? {}));

  // advance 검증: AI가 advance라 했어도 실제 조건이 다 차야 허용 (가드)
  let transition: StageResult["transition"];
  switch (out.transition) {
    case "advance":
      if (advanceReady) {
        transition = { kind: "advance", to: "onboarding", reason: out.transition_reason };
      } else {
        // AI가 잘못 판단 — 강제 stay
        transition = { kind: "stay" };
      }
      break;
    case "abort":
      transition = { kind: "abort", reason: out.transition_reason };
      break;
    case "pause":
      transition = {
        kind: "pause",
        reason: out.transition_reason,
        category: out.handoff_category || undefined,
        suggestedAction: out.suggested_action || undefined,
      };
      break;
    case "stay":
    default:
      transition = { kind: "stay" };
      break;
  }

  // 자동 advance 가드: abort/pause가 아닌데 조건이 모두 찼으면 AI가 stay여도 전이.
  // (마지막 항목이 채워진 턴에서 AI가 advance를 놓쳐 screening에 멈추는 것 방지)
  if (
    out.transition !== "abort" &&
    out.transition !== "pause" &&
    transition.kind !== "advance" &&
    advanceReady
  ) {
    transition = { kind: "advance", to: "onboarding", reason: "체크리스트 7항목 완료 — 자동 전이" };
  }

  // 무한정체 backstop(P1-2): stay 유지인데 체크리스트가 이번 턴 전혀 진전이 없으면 연속 카운트.
  // 3턴 연속 무진전이면 pause로 매니저 인계(자동 진행 없음 — 안전). 모델이 확인만 하고
  // checklist_update를 누락해 스크리닝이 멈추는 케이스 대비. (침묵성 정체는 cron이 별도 커버)
  if (transition.kind === "stay") {
    const beforeTrue = countTrueFlags(ctx.state.screening as Record<string, unknown> | undefined);
    const afterTrue = countTrueFlags(state_update.screening as Record<string, unknown> | undefined);
    const prevStall = Number(ctx.state.meta?.screening_stall_count ?? 0) || 0;
    if (afterTrue > beforeTrue) {
      state_update.meta = { ...state_update.meta, screening_stall_count: 0 };
    } else if (prevStall + 1 >= 3) {
      transition = {
        kind: "pause",
        reason: "스크리닝 진행 정체 — 체크리스트 3턴 연속 무변화, 매니저 확인 필요",
        suggestedAction: "AI가 체크리스트를 채우지 못하고 있습니다. 대화를 확인해 매니저가 직접 진행하세요.",
      };
      state_update.meta = { ...state_update.meta, screening_stall_count: 0 };
    } else {
      state_update.meta = { ...state_update.meta, screening_stall_count: prevStall + 1 };
    }
  }

  // advance 시: AI 응답("그럼 온보딩 절차로 안내드릴게요" 식) 발송 생략 →
  // 시스템 자동 발송(비마트: GUIDE 앱설치·교육 안내 / 일반 라인: 선탑 인계 마무리)이
  // 곧바로 나가며 그게 응답을 겸함. (exploration → screening 전환과 동일한 패턴)
  const reply_text = transition.kind === "advance" ? null : out.reply_text;

  // 대화로 확인된 차종을 지원자 프로필에도 반영 — 인재풀 카드·새 공고 안내(자차 매칭)가
  // 폼 제출 당시 값이 아니라 최신 확인 값을 쓰게 한다. '차 없음' 류 표현은 보유 확정이 아니므로 제외.
  let applicant_patch: Record<string, unknown> | undefined;
  if (general && collected?.차종) {
    const v = collected.차종.trim();
    if (v && !v.includes("없")) {
      const patch: Record<string, unknown> = {};
      if (v !== (ctx.applicant.vehicle_type ?? "")) patch.vehicle_type = v;
      if (ctx.applicant.own_vehicle !== "있음") patch.own_vehicle = "있음";
      if (Object.keys(patch).length > 0) applicant_patch = patch;
    }
  }

  return {
    reply_text,
    state_update,
    transition,
    applicant_patch,
    reasoning: out.reasoning,
  };
}

function failResult(reason: string): StageResult {
  return {
    reply_text: null,
    state_update: { meta: { last_reasoning: `screening 실패: ${reason}` } },
    transition: { kind: "pause", reason: `에이전트 호출 실패: ${reason}` },
    reasoning: `screening 호출 실패 (${reason}) — 매니저 인계`,
  };
}
