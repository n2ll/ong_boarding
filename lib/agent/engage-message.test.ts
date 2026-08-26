import assert from "node:assert/strict";
import test from "node:test";

type EngageMessageModule = {
  currentJobWaitlistNotice?: (name: string, jobTitle: string) => string;
};

async function loadModule(): Promise<EngageMessageModule> {
  try {
    const modulePath = "./engage-message.ts";
    return await import(modulePath) as EngageMessageModule;
  } catch {
    return {};
  }
}

test("a full current job sends only its closure notice without promising another job", async () => {
  const { currentJobWaitlistNotice } = await loadModule();

  assert.equal(typeof currentJobWaitlistNotice, "function");
  const message = currentJobWaitlistNotice!("홍길동", "강남 배송원");
  assert.match(message, /강남 배송원/);
  assert.match(message, /모집 인원이 모두 차 마감/);
  assert.match(message, /이번 공고로는 더 진행되지 않/);
  assert.doesNotMatch(message, /새\s*(?:일자리|공고)|다른\s*공고|먼저\s*안내|자리가\s*나/);
});
