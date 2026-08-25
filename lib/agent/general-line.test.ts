import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type JobLineInput = {
  title: string;
  recruit_mode?: string | null;
  client_type?: string | null;
};

type GeneralLineModule = {
  isGeneralLineJob?: (job: JobLineInput | null | undefined) => boolean;
  joinedClientType?: (relation: unknown) => string | null;
};

async function loadGeneralLineModule(): Promise<GeneralLineModule> {
  try {
    const modulePath = "./general-line.ts";
    return await import(modulePath) as GeneralLineModule;
  } catch {
    return {};
  }
}

test("system reservation jobs keep the legacy B mart flow", async () => {
  const { isGeneralLineJob } = await loadGeneralLineModule();

  assert.equal(typeof isGeneralLineJob, "function");
  for (const title of ["__baemin_system__", "__danggeun_system__"]) {
    assert.equal(isGeneralLineJob!({
      title,
      recruit_mode: "internal",
      client_type: "general",
    }), false, title);
  }
});

test("only an explicitly B mart client selects the B mart flow for a real job", async () => {
  const { isGeneralLineJob } = await loadGeneralLineModule();

  assert.equal(typeof isGeneralLineJob, "function");
  for (const recruit_mode of ["external", "internal", "both"]) {
    assert.equal(isGeneralLineJob!({
      title: "비마트 배송원",
      recruit_mode,
      client_type: "baemin_bmart",
    }), false, recruit_mode);
  }
});

test("general and unclassified real jobs use the general line regardless of acquisition channel", async () => {
  const { isGeneralLineJob } = await loadGeneralLineModule();

  assert.equal(typeof isGeneralLineJob, "function");
  for (const client_type of [
    "general",
    "danggeun",
    "future_client_type",
    null,
    null,
    undefined,
  ]) {
    for (const recruit_mode of ["external", "internal", "both", null]) {
      assert.equal(isGeneralLineJob!({
        title: "일반 배송원",
        recruit_mode,
        client_type,
      }), true, `${String(client_type)} / ${String(recruit_mode)}`);
    }
  }
});

test("joined client metadata is normalized from PostgREST object and array shapes", async () => {
  const { joinedClientType } = await loadGeneralLineModule();

  assert.equal(typeof joinedClientType, "function");
  assert.equal(joinedClientType!({ client_type: "baemin_bmart" }), "baemin_bmart");
  assert.equal(joinedClientType!([{ client_type: "general" }]), "general");
  assert.equal(joinedClientType!([]), null);
  assert.equal(joinedClientType!(null), null);
  assert.equal(joinedClientType!({ client_type: 123 }), null);
});

test("all production agent loaders include the client type needed for routing", async () => {
  const [router, setStage, confirmSend, reminder] = await Promise.all([
    readFile(new URL("./router.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/admin/agent/set-stage/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/admin/confirm/send/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/admin/cron/onboarding-reminder/route.ts", import.meta.url), "utf8"),
  ]);

  for (const [name, source] of [
    ["router", router],
    ["set-stage", setStage],
    ["confirm/send", confirmSend],
    ["onboarding-reminder", reminder],
  ] as const) {
    assert.match(source, /client\s*:\s*clients\s*\(\s*client_type/, name);
  }

  assert.match(router, /if \(!job\) \{[\s\S]*?job context missing — agent not run/);
  assert.match(setStage, /targetStage === "active" && isGeneralLineJob\(job\)/);
  assert.match(reminder, /if \(isGeneralLineJob\(job\)\)[\s\S]*?agent_stage:\s*"paused"/);
});
