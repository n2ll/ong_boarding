import assert from "node:assert/strict";
import test from "node:test";

test("AI follow-up asks only for required facts the memo did not provide", async () => {
  const followupModule = await import("./job-create-followup.ts").catch(() => null);
  const missingFields = followupModule?.missingJobCreateFollowupFields;

  assert.equal(typeof missingFields, "function");
  if (typeof missingFields !== "function") return;

  assert.deepEqual(
    missingFields({
      capacity: "",
      pickupAddress: "성수 물류센터 3번 게이트",
      dropoffAddress: "",
      payInfo: "건당 3,500원 · 매주 금요일 정산",
    }),
    ["capacity", "dropoffAddress"],
  );

  assert.deepEqual(
    missingFields({
      capacity: 3,
      pickupAddress: "성수 물류센터 3번 게이트",
      dropoffAddress: "하남 미사 일대",
      payInfo: "건당 3,500원 · 매주 금요일 정산",
    }),
    [],
  );
});

const operationCases = [
  {
    name: "수거와 반납이 있는 초안에서 빠진 운행 조건만 묻는다",
    body: "[운행 안내]\n가방 수거 후 반납합니다.",
    fields: ["collectionMode", "collectionBagDate", "returnPlace", "returnDeadline"],
  },
  {
    name: "맞수거를 가방 기준일이나 반납 의무로 추정하지 않는다",
    body: "[운행 안내]\n가방을 맞수거합니다.",
    fields: ["collectionBagDate"],
  },
  {
    name: "배송 날짜와 상차지는 수거 가방 기준일·반납 조건을 대신하지 않는다",
    body: "[운행 안내]\n당일 오전 7시 성수 센터에서 상차\n가방 수거 후 반납",
    fields: ["collectionMode", "collectionBagDate", "returnPlace", "returnDeadline"],
  },
  {
    name: "완료 후 당일 반납이면 별도의 시각을 요구하지 않는다",
    body: "[운행 안내]\n배송하면서 전날 가방을 맞수거합니다.\n- 반납 방식·기한: 배송 완료 후 당일 반납\n- 반납 상세 주소: 서울시 성동구 가상로 12",
    fields: [],
  },
  {
    name: "별도 재방문 수거와 기한·거점이 명시되면 질문하지 않는다",
    body: "[운행 안내]\n오후 재방문하여 당일 가방 수거\n서쪽 거점에 18시까지 반납",
    fields: [],
  },
  {
    name: "도로명 주소에 당일 반납한다고 적혀 있으면 장소를 다시 묻지 않는다",
    body: "배송하면서 전날 가방 맞수거\n금천구 가마산로 96 당일 반납",
    fields: [],
  },
  {
    name: "명시적 수거 없음에는 질문하지 않는다",
    body: "[운행 안내]\n가방 수거는 없습니다. 반납도 하지 않습니다.",
    fields: [],
  },
  {
    name: "항목명 뒤에 콜론으로 명시한 수거·반납 없음에도 질문하지 않는다",
    body: "[운행 안내]\n수거: 없음\n반납: 없음",
    fields: [],
  },
  {
    name: "수거 없는 배송 전용 공고와 업무 제목에는 질문하지 않는다",
    body: "배송·수거·반납 안내\n[운행 안내]\n수거 없이 배송만 진행합니다.",
    fields: [],
  },
  {
    name: "미정으로 적힌 반납 조건은 계속 확인한다",
    body: "전날 가방 맞수거\n반납 장소: 미정\n반납 기한: 별도 확인",
    fields: ["returnPlace", "returnDeadline"],
  },
  {
    name: "가방이 아닌 수거품에는 가방 기준일을 묻지 않는다",
    body: "배송 중 빈 상자를 수거합니다. 반납은 없습니다.",
    fields: [],
  },
  {
    name: "수거·반납이 없는 초안에는 질문하지 않는다",
    body: "[운행 안내]\n성수 센터에서 강남권 배송",
    fields: [],
  },
];

for (const { name, body, fields } of operationCases) {
  test(name, async () => {
    const followup = await import("./job-create-followup.ts");
    const missing = (followup as Record<string, unknown>).missingJobCreateOperationFields;
    assert.equal(typeof missing, "function");
    assert.deepEqual((missing as (body: string) => string[])(body), fields);
  });
}
