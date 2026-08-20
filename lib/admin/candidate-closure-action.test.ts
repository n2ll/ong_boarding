import assert from "node:assert/strict";
import test from "node:test";

type CandidateClosureAction = {
  confirm: {
    title: string;
    description: string;
    confirmText: string;
    destructive?: boolean;
  };
  mutation: { agent_stage: "abort"; closed_reason: string };
  successMessage: string;
};

type CandidateClosureActionModule = {
  candidateClosureAction?: (kind: "hold" | "disqualify", candidateName: string) => CandidateClosureAction;
};

async function loadModule(): Promise<CandidateClosureActionModule> {
  try {
    return await import(new URL("./candidate-closure-action.ts", import.meta.url).href) as CandidateClosureActionModule;
  } catch {
    return {};
  }
}

test("holding a candidate requires an explicit reversible-scope confirmation", async () => {
  const { candidateClosureAction } = await loadModule();

  assert.equal(typeof candidateClosureAction, "function");
  const action = candidateClosureAction!("hold", "홍길동");
  assert.deepEqual(action.mutation, { agent_stage: "abort", closed_reason: "manager: 보류" });
  assert.equal(action.confirm.title, "홍길동님을 이 공고에서 보류할까요?");
  assert.match(action.confirm.description, /인력풀에는 유지/);
  assert.equal(action.confirm.confirmText, "보류");
  assert.equal(action.confirm.destructive, undefined);
});

test("disqualifying a candidate is destructive only for the selected job and says so", async () => {
  const { candidateClosureAction } = await loadModule();

  assert.equal(typeof candidateClosureAction, "function");
  const action = candidateClosureAction!("disqualify", "김지원");
  assert.deepEqual(action.mutation, { agent_stage: "abort", closed_reason: "manager: 공고부적합" });
  assert.equal(action.confirm.title, "김지원님을 이 공고에서 부적합 처리할까요?");
  assert.match(action.confirm.description, /이 공고에서만/);
  assert.match(action.confirm.description, /인력풀에는 유지/);
  assert.equal(action.confirm.confirmText, "공고부적합");
  assert.equal(action.confirm.destructive, true);
});
