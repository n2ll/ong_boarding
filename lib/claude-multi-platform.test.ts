import assert from "node:assert/strict";
import test from "node:test";

test("multi-channel generation asks Claude only for the supported job-board and SMS drafts", async () => {
  const previousKey = process.env.CLAUDE_API;
  const previousFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;

  const generated = {
    title: "성수 배송 기사 모집",
    fields: {
      company: "옹고잉",
      location: "서울 성동구",
      pay: "건당 3,500원",
      schedule: "오전 3시~9시",
      role: "배송",
      tags: ["자차 필수"],
    },
    albamon: { title: "성수 배송 기사 모집", body: "[모집부문]\n- 배송" },
    sms: { title: "배송 모집 안내", body: "📦 업무: 배송" },
  };

  process.env.CLAUDE_API = "test-key";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      content: [{ type: "tool_use", name: "generate_multi_posting", input: generated }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const { generateMultiPlatformPosting } = await import("./claude.ts");
    const result = await generateMultiPlatformPosting("성수 배송", undefined, "상차지: 성수 물류센터");

    assert.deepEqual(result, generated);
    assert.ok(requestBody);
    const request = requestBody as {
      system: string;
      tools: Array<{
        description: string;
        input_schema: { properties: Record<string, unknown>; required: string[] };
      }>;
    };
    assert.deepEqual(
      Object.keys(request.tools[0].input_schema.properties),
      ["title", "fields", "albamon", "sms"],
    );
    const fieldsSchema = request.tools[0].input_schema.properties.fields as {
      properties: Record<string, unknown>;
      required: string[];
    };
    assert.deepEqual(
      Object.keys(fieldsSchema.properties),
      [
        "company",
        "location",
        "pickupAddress",
        "dropoffAddress",
        "pay",
        "schedule",
        "capacity",
        "vehicleRequired",
        "workPeriod",
        "slotKeys",
        "role",
        "tags",
      ],
    );
    assert.deepEqual(fieldsSchema.required, Object.keys(fieldsSchema.properties));
    assert.deepEqual(request.tools[0].input_schema.required, ["title", "fields", "albamon", "sms"]);
    assert.doesNotMatch(request.system, /당근|danggeun/i);
    assert.doesNotMatch(request.tools[0].description, /당근|danggeun/i);
    assert.match(request.system, /#\{이름\}/);
    assert.match(request.system, /#\{맞춤링크\}/);
    assert.match(request.system, /배정·근무 확정이 아니며/);
    assert.match(request.system, /상차지·집결지와 배송 권역·마지막 경유지를 구분/);
    assert.doesNotMatch(request.system, /'지원'이라고 답장/);
  } finally {
    if (previousKey === undefined) delete process.env.CLAUDE_API;
    else process.env.CLAUDE_API = previousKey;
    globalThis.fetch = previousFetch;
  }
});
