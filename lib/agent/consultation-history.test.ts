import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { loadConsultationHistory } from "./consultation-history.ts";
import type { ConsultationJob, ConsultationSourceMessage } from "./consultation-types.ts";

interface MessageRow extends ConsultationSourceMessage {
  applicant_id: number;
  direction: "inbound" | "outbound";
  sent_by: string | null;
  job_id: number | null;
}

const jobs: ConsultationJob[] = [
  { job_id: 11, candidate_id: 1, title: "용산 배송", branch: "용산", stage: "screening", expired: false },
  { job_id: 22, candidate_id: 2, title: "강남 배송", branch: "강남", stage: null, expired: false },
];
function message(index: number, body: string, patch: Partial<MessageRow> = {}): MessageRow {
  return { id: `message-${String(index).padStart(3, "0")}`, body, created_at: new Date(Date.UTC(2026, 8, 6, 0, 0, index)).toISOString(), applicant_id: 7, direction: "inbound", sent_by: null, job_id: 11, ...patch };
}
function client(rows: MessageRow[], error = false) {
  let queries = 0;
  const supabase = createClient("https://consultation.invalid", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      queries++;
      assert.equal(init?.method, "GET");
      const url = new URL(String(input));
      assert.equal(url.pathname, "/rest/v1/messages");
      assert.equal(url.searchParams.get("applicant_id"), "eq.7");
      assert.equal(url.searchParams.get("limit"), "50", "최근 문맥만 제한해서 읽는다");
      assert.ok(url.searchParams.get("order")?.startsWith("created_at.desc"));
      if (error) return Response.json({ message: "history failed" }, { status: 400 });
      const boundary = url.searchParams.get("created_at");
      assert.ok(boundary && boundary.startsWith("lte."), "처리 중인 수신문자 이후의 문맥은 섞지 않는다");
      const data = rows.filter((row) => row.applicant_id === 7 && Date.parse(row.created_at) <= Date.parse(boundary.slice(4)))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id)).slice(0, 50);
      return Response.json(data);
    } },
  });
  return { supabase, queries: () => queries };
}

test("다른 지원자·미래 문자는 빼고 마지막 상담 답변 뒤 연속 수신 원문을 모두 보존한다", async () => {
  const current = message(5, "  [Web발신] 강남도 관심 있어요  ");
  const { supabase } = client([
    message(1, "예전 가능 시간"),
    message(2, "용산 조건을 안내드릴게요", { direction: "outbound", sent_by: "agent" }),
    message(3, "[국제발신] 용산은 월요일 가능해요"),
    message(4, "새 공고 알림", { direction: "outbound", sent_by: "agent-engage", job_id: 22 }),
    current,
    message(6, "아직 처리하면 안 되는 다음 문자"),
    message(4, "다른 지원자 발언", { applicant_id: 8 }),
  ]);
  const result = await loadConsultationHistory(supabase, 7, current, jobs);
  assert.deepEqual(result.sourceMessages, [
    { id: "message-003", body: "[국제발신] 용산은 월요일 가능해요", created_at: "2026-09-06T00:00:03.000Z" },
    { id: current.id, body: current.body, created_at: current.created_at },
  ]);
  assert.deepEqual(result.history.map((turn) => turn.body), ["예전 가능 시간", "용산 조건을 안내드릴게요", "[국제발신] 용산은 월요일 가능해요"]);
  assert.equal(result.ambiguousFollowup, false);
});

test("현재 문자가 DB 결과에 없어도 sourceMessages에 정확히 한 번 추가한다", async () => {
  const current = message(3, "지금 보낸 문자");
  const { supabase } = client([message(1, "용산 문의", { direction: "outbound", sent_by: "관리자" }), message(2, "첫 번째 답변")]);
  const result = await loadConsultationHistory(supabase, 7, current, jobs);
  assert.deepEqual(result.sourceMessages.map((row) => row.id), ["message-002", "message-003"]);
  assert.deepEqual(result.history.map((turn) => turn.body), ["용산 문의", "첫 번째 답변"]);
});

for (const outbound of [
  { body: "용산은 오전이고 강남은 오후예요", job_id: 11 },
  { body: "어느 자리인지 알려주세요", job_id: null },
]) {
  test(`복수 공고 또는 미지정 상담 답변 뒤의 짧은 답은 모호함을 보존한다: ${outbound.body}`, async () => {
    const current = message(3, "네");
    const { supabase } = client([message(1, "이전 단일 대화", { direction: "outbound", sent_by: "agent" }), message(2, outbound.body, { ...outbound, direction: "outbound", sent_by: "agent" }), current]);
    assert.equal((await loadConsultationHistory(supabase, 7, current, jobs)).ambiguousFollowup, true);
  });
}

test("새로운 단일 공고 상담 답변이 있으면 이전 비교 답변의 모호함을 잇지 않는다", async () => {
  const current = message(3, "네");
  const { supabase } = client([message(1, "용산과 강남 안내", { direction: "outbound", sent_by: "agent", job_id: null }), message(2, "용산은 오전입니다", { direction: "outbound", sent_by: "agent-practice" }), current]);
  assert.equal((await loadConsultationHistory(supabase, 7, current, jobs)).ambiguousFollowup, false);
});

test("대량·광고·공고 안내 문자는 history와 마지막 상담 답변에서 제외한다", async () => {
  const current = message(7, "네");
  const { supabase } = client([
    message(1, "용산과 강남 조건입니다", { direction: "outbound", sent_by: "system-auto", job_id: null }),
    message(2, "주말 가능해요"),
    message(3, "공고 안내", { direction: "outbound", sent_by: "agent-engage" }),
    message(4, "대량 발송", { direction: "outbound", sent_by: "system-bulk" }),
    message(5, "[Web발신]\n(광고) 새 공고 안내", { direction: "outbound", sent_by: "system-auto" }),
    message(6, "외부 발송", { direction: "outbound", sent_by: "unknown" }), current,
  ]);
  const result = await loadConsultationHistory(supabase, 7, current, jobs);
  assert.equal(result.ambiguousFollowup, true);
  assert.deepEqual(result.history.map((turn) => turn.body), ["용산과 강남 조건입니다", "주말 가능해요"]);
  assert.deepEqual(result.sourceMessages.map((row) => row.id), ["message-002", "message-007"]);
});

test("상담 답변이 없는 첫 대화의 모든 수신 원문을 합친다", async () => {
  const current = message(2, "월요일 가능합니다");
  const { supabase } = client([message(1, "용산 문의합니다"), current]);
  const result = await loadConsultationHistory(supabase, 7, current, jobs);
  assert.equal(result.ambiguousFollowup, false);
  assert.deepEqual(result.sourceMessages.map((row) => row.id), ["message-001", "message-002"]);
});

test("최신 50건 상한에서 미응답 연속 문자의 시작을 확인하지 못하면 안전하게 중단한다", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => message(i, `연속 문자 ${i}`));
  const { supabase, queries } = client(rows);
  await assert.rejects(loadConsultationHistory(supabase, 7, rows[50], jobs), /상한|잘린|truncat/);
  assert.equal(queries(), 1, "무제한 과거 대화를 다시 읽지 않는다");
});

test("50건 상한 안에 마지막 상담 답변이 있으면 완전한 미응답 문자를 사용할 수 있다", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => message(i, `문자 ${i}`));
  rows[48] = message(48, "용산 안내", { direction: "outbound", sent_by: "agent" });
  const { supabase } = client(rows);
  const result = await loadConsultationHistory(supabase, 7, rows[50], jobs);
  assert.deepEqual(result.sourceMessages.map((row) => row.id), ["message-049", "message-050"]);
  assert.equal(result.history.length, 49);
  assert.equal(result.history[0].body, "문자 1");
});

test("대화 조회 실패를 비어 있는 상담 기록으로 바꾸지 않는다", async () => {
  const { supabase } = client([], true);
  await assert.rejects(loadConsultationHistory(supabase, 7, message(1, "문의"), jobs), /history failed/);
});
