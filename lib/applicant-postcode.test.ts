import assert from "node:assert/strict";
import test from "node:test";

type ApplicantPostcodeModule = {
  embedApplicantPostcode?: (input: {
    container: unknown;
    create: () => { embed: (container: unknown) => void };
    onError: () => void;
  }) => boolean;
  applicantPostcodePresentation?: (
    address: string,
    manualEntry: boolean,
  ) => {
    mode: "search" | "selected" | "manual";
    actionLabel: string;
    statusMessage: string | null;
  };
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

test("postcode presentation keeps search primary until an address is selected", async () => {
  const { applicantPostcodePresentation } = await loadModule();
  assert.equal(typeof applicantPostcodePresentation, "function");

  assert.deepEqual(applicantPostcodePresentation!("", false), {
    mode: "search",
    actionLabel: "주소 검색해서 선택하기",
    statusMessage: null,
  });
});

test("postcode presentation announces a selected address and offers a change action", async () => {
  const { applicantPostcodePresentation } = await loadModule();
  assert.equal(typeof applicantPostcodePresentation, "function");

  assert.deepEqual(
    applicantPostcodePresentation!("서울 강남구 테헤란로 123", false),
    {
      mode: "selected",
      actionLabel: "주소 변경",
      statusMessage: "주소 선택 완료: 서울 강남구 테헤란로 123",
    },
  );
});

test("postcode presentation gives manual fallback its own editable mode", async () => {
  const { applicantPostcodePresentation } = await loadModule();
  assert.equal(typeof applicantPostcodePresentation, "function");

  assert.deepEqual(applicantPostcodePresentation!("", true), {
    mode: "manual",
    actionLabel: "주소 검색 사용하기",
    statusMessage: null,
  });
});

test("postcode presentation keeps an invalid restored address editable instead of marking success", async () => {
  const { applicantPostcodePresentation } = await loadModule();
  assert.equal(typeof applicantPostcodePresentation, "function");

  assert.deepEqual(applicantPostcodePresentation!("서울 강남구 역삼동", false), {
    mode: "manual",
    actionLabel: "주소 검색 사용하기",
    statusMessage: null,
  });
});
