/** 수거는 공고별 업무다. 공통 예시·다른 공고·지원자의 질문으로 빈 운영 조건을 채우지 않는다. */
export const DELIVERY_COLLECTION_GUIDANCE = `
## 배송·수거·반납 근거
수거는 해당 배송 공고에 명시된 업무에 한해서만 안내한다. 배송과 함께 전날 가방을 맞수거하는 방식, 당일 오후 재방문해 당일 가방을 수거하는 방식 등은 공고마다 다르며 공통 규칙이 아니다.
수거 여부·대상·방식·재방문·반납 장소·시각은 지금 질문한 공고 원문에 명시된 범위만 인용한다. '맞수거'만 적혀 있으면 전날/당일 가방인지, 모든 배송지인지 덧붙이지 마라. 배송시간이나 집결지는 수거·반납 시각/장소의 근거가 아니다.
공고에 수거가 미기재면 '이 공고에는 수거 업무가 안내되어 있지 않아요'처럼 기재 상태만 설명한다. 수거가 전혀 없다고 단정하거나 추가 수거·재방문·반납 절차를 만들지 마라. 물은 세부 조건이 없으면 미기재임을 밝히고 필요하면 매니저에게 확인을 넘긴다.
복수 공고는 각 공고의 원문을 따로 사용한다. 다른 공고, 공통 FAQ, 대화 예시, 운영 메모나 지원자 발언으로 수거 조건을 보충하지 마라. 이 근거 규칙은 일반 운영 안내보다 우선한다. 상세 주소·연락처는 기존 매니저 안내 규칙을 따른다.
`;

const COLLECTION = /수거|회수|재방문|반납/;
export const COLLECTION_NOT_STATED = "이 공고에는 수거·반납 업무가 안내되어 있지 않아요.";
// 상세 주소·연락처는 상담 facts에 공개하지 않는 기존 계약을 유지한다.
const PRIVATE_DETAIL = /[가-힣]+(?:로|길)\s*\d|[가-힣]+동\s+\d|\d+\s*(?:동|호)(?:\s|[.,]|$)|0\d{1,2}[- )]?\d{3,4}[- ]?\d{4}|연락처|전화번호/;

/** 다른 필드나 모델 요약을 섞지 않고 해당 본문의 연속된 원문 문장만 인용한다. */
export function collectionFactFromBody(body: string | null | undefined): string | null {
  if (!body?.trim()) return null;
  if (!COLLECTION.test(body)) return COLLECTION_NOT_STATED;
  const quotes = (body.match(/[^\r\n.!?]+[.!?]?/g) ?? [])
    .map((quote) => quote.trim())
    .filter((quote) => COLLECTION.test(quote) && !PRIVATE_DETAIL.test(quote))
    // 제목만으로 실제 업무가 있다고 해석하지 않는다.
    .filter((quote) => !/^[\s#•*\-\d.)]*(?:수거|회수|재방문|반납|·|\/|및|안내|업무|절차|:)+\s*$/.test(quote));
  const fact = [...new Set(quotes)].join("\n");
  return fact && fact.length <= 2_000 ? fact : null;
}

/** 배송 근무 조건도 따로 묻는 문자는 복수 항목 답변을 유지한다. */
export function isCollectionOnlyQuestion(text: string): boolean {
  return COLLECTION.test(text) && !/(?:배송|근무|출근|상차|집결)[\s·]*(?:시간|일정|시작|급여|대금|장소)|급여|차량|교육|선탑/.test(text);
}
