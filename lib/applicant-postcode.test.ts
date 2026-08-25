import assert from "node:assert/strict";
import test from "node:test";

type ApplicantPostcodeModule = {
  embedApplicantPostcode?: (input: {
    container: unknown;
    create: () => { embed: (container: unknown) => void };
    onError: () => void;
  }) => boolean;
};

async function loadModule(): Promise<ApplicantPostcodeModule> {
  try {
    const modulePath = "./applicant-postcode.ts";
    return await import(modulePath) as ApplicantPostcodeModule;
  } catch {
    return {};
  }
}

test("postcode constructor and embed failures invoke recovery instead of escaping", async () => {
  const { embedApplicantPostcode } = await loadModule();
  assert.equal(typeof embedApplicantPostcode, "function");

  const container = {};
  for (const failureStage of ["constructor", "embed"] as const) {
    let recoveryCount = 0;
    const result = embedApplicantPostcode!({
      container,
      create: () => {
        if (failureStage === "constructor") throw new Error("constructor failed");
        return {
          embed: () => {
            throw new Error("embed failed");
          },
        };
      },
      onError: () => {
        recoveryCount += 1;
      },
    });

    assert.equal(result, false, `${failureStage} failure should be reported`);
    assert.equal(recoveryCount, 1, `${failureStage} failure should invoke recovery once`);
  }
});

test("a successful postcode embed does not invoke recovery", async () => {
  const { embedApplicantPostcode } = await loadModule();
  assert.equal(typeof embedApplicantPostcode, "function");

  const container = {};
  let embeddedContainer: unknown = null;
  let recoveryCount = 0;
  const result = embedApplicantPostcode!({
    container,
    create: () => ({
      embed: (target) => {
        embeddedContainer = target;
      },
    }),
    onError: () => {
      recoveryCount += 1;
    },
  });

  assert.equal(result, true);
  assert.equal(embeddedContainer, container);
  assert.equal(recoveryCount, 0);
});
