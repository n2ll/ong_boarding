import assert from "node:assert/strict";
import test from "node:test";
import { collectionFactFromBody } from "../agent/delivery-collection.ts";

import * as jobOperationsSection from "./job-operations-section.ts";
const { getJobOperationsSection: get, replaceJobOperationsSection: replace } = jobOperationsSection;
function canEdit(body: string): boolean {
  assert.equal(typeof jobOperationsSection.canEditJobOperationsSection, "function");
  return jobOperationsSection.canEditJobOperationsSection(body);
}

test("운행 안내의 맞수거·재방문·반납 조건과 본문 속 대괄호 문구를 모두 읽는다", () => {
  const content = "일부 배송지는 맞수거, 나머지는 재방문 수거합니다.\n[주의] 수거 여부는 배송지마다 다릅니다.\n당일 서쪽 거점에 반납하며 반납 시각은 별도 확인합니다.";
  assert.equal(get(`배송 공고\n\n[운행 안내]\n${content}\n[급여]\n건당 협의`), content);
});

test("운행 안내만 교체하고 앞뒤 급여·지원 조건과 문단 구분을 그대로 보존한다", () => {
  const before = "배송 공고\n[급여]\n일급 12만 원 · 반납 포함\n\n[운행 안내]\n";
  const after = "\n\n[지원 조건]\n운전면허 필수\n자차 여부 확인\n";
  const body = `${before}기존 상차지에서 맞수거 후 반납${after}`;
  const updated = replace(body, "새 상차지에서 배송\n일부 맞수거 후 당일 반납\n");
  assert.equal(updated, `${before}새 상차지에서 배송\n일부 맞수거 후 당일 반납${after}`);
  assert.equal(replace(body, get(body)!), body);
});

test("정식 단독 제목이 없으면 키워드나 인라인 제목으로 구역을 추정하지 않는다", () => {
  for (const body of ["", "반납은 당일이며 맞수거가 있습니다.", "본문의 [운행 안내] 참고", "**[운행 안내]**\n배송 후 반납", "[급여]\n반납 포함 12만 원"]) {
    assert.equal(get(body), null);
    assert.equal(replace(body, "바꿀 내용"), body);
    assert.equal(canEdit(body), false);
  }
});

test("운행 안내 제목이 중복되면 어느 구역도 임의로 읽거나 교체하지 않는다", () => {
  const body = "[운행 안내]\n맞수거\n[급여]\n협의\n \t[운행 안내] \t\n별도 반납";
  assert.equal(get(body), null);
  assert.equal(replace(body, "새 운행"), body);
  assert.equal(canEdit(body), false);
});

test("빈 구역도 편집할 수 있고 비워도 다음 구역을 합치거나 지우지 않는다", () => {
  const empty = "[운행 안내]\n[지원 조건]\n면허 필수";
  assert.equal(get(empty), "");
  assert.equal(replace(empty, "반납지 확인 필요"), "[운행 안내]\n반납지 확인 필요\n[지원 조건]\n면허 필수");
  const cleared = replace("[운행 안내]\n맞수거\n[지원 조건]\n면허 필수", "");
  assert.equal(get(cleared), "");
  assert.ok(cleared.endsWith("\n[지원 조건]\n면허 필수"));
});

test("마지막 구역은 EOF까지 읽고 제목만 있는 EOF에도 내용 줄을 추가한다", () => {
  assert.equal(get("[급여]\n협의\n[운행 안내]\n배송 후 재방문 수거"), "배송 후 재방문 수거");
  assert.equal(replace("[급여]\n협의\n[운행 안내]\n배송 후 재방문 수거", "당일 반납"), "[급여]\n협의\n[운행 안내]\n당일 반납");
  assert.equal(get("[운행 안내]"), "");
  assert.equal(replace("[운행 안내]", "맞수거"), "[운행 안내]\n맞수거");
});

test("CRLF와 제목 주변 공백을 보존하고 새 내용도 해당 구역의 줄바꿈으로 기록한다", () => {
  const before = "배송 공고\r\n\r\n \t[운행 안내] \t\r\n";
  const after = "\r\n\r\n [급여] \r\n반납 포함 12만 원\r\n";
  const body = `${before}맞수거\r\n재방문 수거${after}`;
  assert.equal(get(body), "맞수거\r\n재방문 수거\r\n");
  assert.equal(replace(body, "배송\n당일 반납\n"), `${before}배송\r\n당일 반납${after}`);
});

test("편집 내용 끝의 줄바꿈을 왕복 보존해 Enter 뒤에 다음 줄을 이어 쓸 수 있다", () => {
  for (const body of ["[운행 안내]\n기존 내용\n[급여]\n협의", "[운행 안내]\n기존 내용"]) {
    const firstLine = "- 수거: 오후 재방문\n";
    const afterEnter = replace(body, firstLine);
    assert.equal(get(afterEnter), firstLine);
    const nextLine = `${get(afterEnter)}- 반납: 당일\n\n`;
    assert.equal(get(replace(afterEnter, nextLine)), nextLine);
  }
});

test("운행 안내를 교체한 본문에서 상담 수거 근거도 이전 맞수거 대신 새 조건을 읽는다", () => {
  const body = "배송 공고\n[운행 안내]\n배송하면서 전날 가방을 맞수거합니다.\n[급여]\n일급 협의";
  assert.equal(collectionFactFromBody(body), "배송하면서 전날 가방을 맞수거합니다.");
  const updated = replace(body, "오후 재방문하여 당일 가방 수거");
  assert.equal(collectionFactFromBody(updated), "오후 재방문하여 당일 가방 수거");
});

test("운행 조건이 단일 운행 안내에만 있는 본문은 빠른 편집을 허용한다", () => {
  assert.equal(canEdit("가상 배송 공고\n[급여]\n일급 12만 원\n[운행 안내]\n07:30 상차 후 배송·맞수거\n오후 재방문 회수 후 당일 반납\n[지원 조건]\n운전면허 필수"), true);
  assert.equal(canEdit("[운행 안내]"), true);
});

test("근무조건에 운행 시각과 맞수거가 중복되면 옛 조건이 남지 않도록 전체 편집을 요구한다", () => {
  const body = "가상 배송 공고\n[근무조건]\n근무시간: 07:00~10:00 (상차·배송·맞수거)\n[운행 안내]\n배송하면서 전날 가방을 맞수거합니다.\n[급여]\n일급 12만 원";
  assert.equal(canEdit(body), false);
  assert.equal(get(body), "배송하면서 전날 가방을 맞수거합니다.");
  assert.ok(replace(body, "오후 재방문하여 당일 가방 수거").includes("근무시간: 07:00~10:00 (상차·배송·맞수거)"));
});

test("운행 안내 밖의 시각은 운행 키워드가 없어도 전체 편집으로 보낸다", () => {
  for (const time of ["7:30", "07:30", "18:00", "오전 7시~10시", "오후 2 시 전후"]) {
    assert.equal(canEdit(`시작 ${time}\n[운행 안내]\n배송 후 반납`), false);
    assert.equal(canEdit(`[운행 안내]\n배송 후 반납\n[근무조건]\n시작 ${time}`), false);
  }
});

test("외부 주소 라벨·직무명·급여의 운행 키워드도 보수적으로 전체 편집으로 보낸다", () => {
  for (const outside of ["상차지: 가상 동쪽 센터", "반납지: 가상 서쪽 센터", "가방 수거 담당 모집", "급여: 수거포함 12만 원", "회수 업무", "재방문 가능자"]) {
    assert.equal(canEdit(`[기본 정보]\n${outside}\n[운행 안내]\n배송 조건 확인`), false);
  }
});
