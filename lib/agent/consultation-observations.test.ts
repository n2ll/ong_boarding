import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createClient } from "@supabase/supabase-js";
import ts from "typescript";
import { saveConsultationObservations } from "./consultation-observations.ts";
import type { ConsultationObservation, ConsultationSourceMessage } from "./consultation-types.ts";

type EventRow = { applicant_id: number; job_id: number; event_type: string; action_key: string; meta: { source: string; source_message_id: string; source_created_at: string; observations: { kind: string; quote: string }[] } };

function eventStore(options: { writeError?: boolean; readError?: boolean; race?: boolean } = {}) {
  const events: EventRow[] = [];
  let writes = 0;
  const supabase = createClient("https://consultation.invalid", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/rest/v1/pool_events", "후보·지원자·focus를 변경하지 않는다");
      if (init?.method === "POST") {
        writes++;
        assert.equal(url.searchParams.has("on_conflict"), false, "partial unique index에 PostgREST upsert를 사용하지 않는다");
        const rows = JSON.parse(String(init.body)) as EventRow[];
        assert.ok(Array.isArray(rows), "관찰들은 한 번에 저장한다");
        if (options.writeError) return Response.json({ code: "XX000", message: "write failed" }, { status: 400 });
        if (options.race && events.length === 0) events.push(rows[0]);
        if (rows.some((row) => events.some((event) => event.action_key === row.action_key))) {
          return Response.json({ code: "23505", message: "duplicate key" }, { status: 409 });
        }
        events.push(...rows);
        return new Response(null, { status: 201 });
      }
      assert.equal(init?.method, "GET");
      if (options.readError) return Response.json({ code: "XX000", message: "read failed" }, { status: 400 });
      const keys = (url.searchParams.get("action_key") ?? "").slice(4, -1).split(",");
      return Response.json(events.filter((row) => keys.includes(row.action_key)));
    } },
  });
  return { supabase, events, writes: () => writes };
}

const sources: ConsultationSourceMessage[] = [
  { id: "sms-1", body: "용산은 월요일 오전 가능하고 강남도 관심 있어요", created_at: "2026-09-06T01:00:00Z" },
  { id: "sms-2", body: "용산은 화요일도 가능해요", created_at: "2026-09-06T01:00:01Z" },
];
const observations: ConsultationObservation[] = [
  { job_id: 11, source_message_id: "sms-1", kind: "availability", quote: "용산은 월요일 오전 가능" },
  { job_id: 22, source_message_id: "sms-1", kind: "interest", quote: "강남도 관심 있어요" },
  { job_id: 11, source_message_id: "sms-2", kind: "availability", quote: "용산은 화요일도 가능해요" },
];

test("공고·원문 문자별 관찰을 한 번에 기록하고 동일 실행을 다시 저장하지 않는다", async () => {
  const store = eventStore();
  await saveConsultationObservations(store.supabase, 7, observations, sources);
  assert.equal(store.writes(), 1);
  assert.equal(store.events.length, 3);
  assert.deepEqual(store.events[0].meta, { source: "inbound_sms", source_message_id: "sms-1", source_created_at: "2026-09-06T01:00:00Z", observations: [{ kind: "availability", quote: "용산은 월요일 오전 가능" }] });
  assert.deepEqual(store.events.map((row) => [row.applicant_id, row.job_id, row.event_type]), [[7, 11, "job_consultation_observation"], [7, 22, "job_consultation_observation"], [7, 11, "job_consultation_observation"]]);
  const first = structuredClone(store.events);
  await saveConsultationObservations(store.supabase, 7, [...observations].reverse(), sources);
  assert.deepEqual(store.events, first);
  assert.equal(new Set(store.events.map((row) => row.action_key)).size, 3);
  for (const row of store.events) assert.match(row.action_key, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
});

test("같은 공고·문자의 서로 다른 종류와 원문을 모두 보존하고 반복 항목만 합친다", async () => {
  const store = eventStore();
  const rows: ConsultationObservation[] = [observations[0], { ...observations[0], kind: "interest", quote: "월요일 오전 가능" }, observations[0]];
  await saveConsultationObservations(store.supabase, 7, rows, sources);
  assert.equal(store.events.length, 1);
  assert.deepEqual(store.events[0].meta.observations, [{ kind: "availability", quote: "용산은 월요일 오전 가능" }, { kind: "interest", quote: "월요일 오전 가능" }]);
});

test("빈 관찰은 DB 호출 없이 끝난다", async () => {
  const store = eventStore({ writeError: true });
  await saveConsultationObservations(store.supabase, 7, [], []);
  assert.equal(store.writes(), 0);
});

for (const patch of [{ source_message_id: "unknown" }, { quote: "금요일 가능" }, { quote: "" }, { quote: " " }, { job_id: 0 }, { kind: "confirmed" }]) {
  test(`근거가 유효하지 않으면 일괄 저장 전 거부한다: ${JSON.stringify(patch)}`, async () => {
    const store = eventStore();
    await assert.rejects(saveConsultationObservations(store.supabase, 7, [observations[0], { ...observations[1], ...patch } as ConsultationObservation], sources));
    assert.equal(store.writes(), 0);
  });
}

test("동일 문자 ID의 서로 다른 본문은 근거로 받아들이지 않는다", async () => {
  const store = eventStore();
  await assert.rejects(saveConsultationObservations(store.supabase, 7, observations, [...sources, { ...sources[0], body: "다른 본문" }]));
  assert.equal(store.writes(), 0);
});

test("먼저 기록된 일부 관찰을 확인한 뒤 나머지만 한 번 추가한다", async () => {
  const store = eventStore({ race: true });
  await saveConsultationObservations(store.supabase, 7, observations, sources);
  assert.equal(store.events.length, 3);
  assert.equal(store.writes(), 2);
});

for (const corruption of ["applicant", "job", "event", "source", "quote"]) {
  test(`중복 키의 ${corruption} 내용이 달라지면 덮어쓰거나 새 관찰을 저장하지 않는다`, async () => {
    const store = eventStore();
    await saveConsultationObservations(store.supabase, 7, [observations[0]], sources);
    const event = store.events[0];
    if (corruption === "applicant") event.applicant_id = 8;
    if (corruption === "job") event.job_id = 12;
    if (corruption === "event") event.event_type = "availability_set";
    if (corruption === "source") event.meta.source_message_id = "another";
    if (corruption === "quote") event.meta.observations[0].quote = "다른 발언";
    await assert.rejects(saveConsultationObservations(store.supabase, 7, observations, sources), /conflict|충돌|일치/);
    assert.equal(store.events.length, 1);
  });
}

test("기록 실패를 성공으로 처리하지 않는다", async () => {
  const store = eventStore({ writeError: true });
  await assert.rejects(saveConsultationObservations(store.supabase, 7, observations, sources), /write failed/);
  assert.equal(store.events.length, 0);
});

test("중복 기록 검증 조회가 실패하면 새 관찰을 추가하지 않는다", async () => {
  const store = eventStore({ readError: true, race: true });
  await assert.rejects(saveConsultationObservations(store.supabase, 7, observations, sources), /read failed/);
  assert.equal(store.events.length, 1);
  assert.equal(store.writes(), 1);
});

// 전체 UI 의존성을 가짜로 대체하지 않고 실제 표시 함수와 순수 타임라인 병합 코드를 실행한다.
const threadSource = ts.createSourceFile("ConversationThread.tsx", readFileSync(new URL("../../components/ConversationThread.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function threadNode(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  }
  visit(threadSource);
  assert.ok(found, "실제 타임라인 구현을 찾을 수 있어야 한다");
  return found;
}

test("매니저 타임라인에 공고명과 종류별 지원자 원문을 표시한다", () => {
  const labelFunction = threadNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === "poolEventLabel");
  const js = ts.transpileModule(labelFunction.getText(threadSource), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const label = runInNewContext(`${js}\npoolEventLabel`, {}) as (event: unknown, jobs: unknown) => string;
  const event = { event_type: "job_consultation_observation", job_id: 11, meta: { observations: [{ kind: "availability", quote: "용산은 월요일 오전 가능" }, { kind: "interest", quote: "관심 있어요" }] } };
  const text = label(event, { 11: { title: "용산 배송" } });
  for (const expected of ["용산 배송", "가용성", "용산은 월요일 오전 가능", "관심", "관심 있어요"]) assert.ok(text.includes(expected), `누락된 표시: ${expected}`);
  assert.match(label(event, {}), /11/);
});

test("매니저 타임라인에서 같은 공고의 연속 관찰 두 건을 모두 보존한다", () => {
  const declaration = threadNode((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === "dedupedEvents"));
  const loop = threadNode((node) => ts.isForOfStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === "currentEvents");
  const js = ts.transpileModule(`${declaration.getText(threadSource)}\n${loop.getText(threadSource)}\ndedupedEvents;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const result = runInNewContext(js, { currentEvents: [
    { id: 1, event_type: "job_consultation_observation", job_id: 11 },
    { id: 2, event_type: "job_consultation_observation", job_id: 11 },
    { id: 3, event_type: "link_view", job_id: null },
    { id: 4, event_type: "link_view", job_id: null },
  ] }) as { id: number }[];
  assert.equal(result.map((item) => item.id).join(","), "1,2,4");
});
