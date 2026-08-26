import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type ApplicantFormData = {
  name: string;
  birthDate: string;
  phone: string;
  location: string;
  ownVehicle: string;
  licenseType: string;
  vehicleType: string;
  branch1: string;
  branch2: string;
  workHours: string[];
  experience: string;
  introduction: string;
  availableDate: string;
  selfOwnership: string;
  marketingConsent: boolean | null;
};

const EMPTY_FORM: ApplicantFormData = {
  name: "",
  birthDate: "",
  phone: "",
  location: "",
  ownVehicle: "",
  licenseType: "",
  vehicleType: "",
  branch1: "",
  branch2: "",
  workHours: [],
  experience: "",
  introduction: "",
  availableDate: "",
  selfOwnership: "",
  marketingConsent: null,
};

async function loadApplicantFormModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./applicant-form.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("settlement-account choices use clear applicant labels while preserving operational values", async () => {
  const applicantFormModule = await loadApplicantFormModule();

  assert.deepEqual(applicantFormModule.APPLICANT_SETTLEMENT_ACCOUNT_OPTIONS, [
    { value: "문제 없음", label: "네, 가능해요" },
    { value: "문제 있음", label: "아니요, 어려워요" },
  ]);
});

test("mobile required choices use radio semantics and explain the consequence without forcing consent", async () => {
  const applyPage = await readFile(new URL("../app/apply/page.tsx", import.meta.url), "utf8");
  const settlementStart = applyPage.indexOf('id="field-selfOwnership"');
  const marketingStart = applyPage.indexOf('id="field-marketingConsent"');

  assert.notEqual(settlementStart, -1);
  assert.notEqual(marketingStart, -1);

  const settlementBlock = applyPage.slice(settlementStart, marketingStart);
  const marketingBlock = applyPage.slice(marketingStart, applyPage.indexOf('type="submit"', marketingStart));
  assert.match(settlementBlock, /role="radiogroup"/);
  assert.match(settlementBlock, /type="radio"/);
  assert.match(settlementBlock, /지원 진행이 어려울 수 있어요/);
  assert.match(marketingBlock, /응답 필수/);
  assert.match(marketingBlock, /아니요, 받지 않을게요/);
});

test("required progress includes an explicit new-job SMS choice", async () => {
  const applicantFormModule = await loadApplicantFormModule();
  const applicantFormProgress = applicantFormModule.applicantFormProgress as
    | ((form: ApplicantFormData) => { completed: number; total: number; percent: number })
    | undefined;

  assert.equal(typeof applicantFormProgress, "function");
  assert.deepEqual(
    applicantFormProgress!({
      ...EMPTY_FORM,
      branch2: "강남점",
      experience: "배달 경력 1년",
      introduction: "성실하게 일하겠습니다.",
      marketingConsent: true,
    }),
    { completed: 1, total: 11, percent: 9 },
  );
});

test("progress only counts required answers that are valid", async () => {
  const applicantFormModule = await loadApplicantFormModule();
  const applicantFormProgress = applicantFormModule.applicantFormProgress as
    | ((form: ApplicantFormData) => { completed: number; total: number; percent: number })
    | undefined;

  assert.equal(typeof applicantFormProgress, "function");
  assert.deepEqual(
    applicantFormProgress!({
      ...EMPTY_FORM,
      name: "김지원",
      birthDate: "60010",
      phone: "01012345678",
      location: "   ",
      ownVehicle: "있음",
    }),
    { completed: 3, total: 12, percent: 25 },
  );
});

test("birth date validation accepts only real YYMMDD calendar dates", async () => {
  const applicantFormModule = await loadApplicantFormModule();
  const isValidApplicantBirthDate = applicantFormModule.isValidApplicantBirthDate as
    | ((value: string) => boolean)
    | undefined;

  assert.equal(typeof isValidApplicantBirthDate, "function");
  for (const value of ["600101", "000229"]) {
    assert.equal(isValidApplicantBirthDate!(value), true, `${value} should be valid`);
  }
  for (const value of ["60010", "196001", "991332", "000230", "생년월일"]) {
    assert.equal(isValidApplicantBirthDate!(value), false, `${value} should be invalid`);
  }
});

test("residence accepts only a road-name address without unit details", async () => {
  const applicantFormModule = await loadApplicantFormModule();
  const isValidApplicantRoadAddress = applicantFormModule.isValidApplicantRoadAddress as
    | ((value: string) => boolean)
    | undefined;

  assert.equal(typeof isValidApplicantRoadAddress, "function");
  for (const value of [
    "서울 강남구 테헤란로 123",
    "서울 서초구 서초대로77길 54",
    "서울특별시 영등포구 영등포로 지하405",
    "광주광역시 동구 4.19로 7",
    "제주특별자치도 제주시 1100로 3348",
  ]) {
    assert.equal(isValidApplicantRoadAddress!(value), true, `${value} should be valid`);
  }
  for (const value of [
    "서울 강남구 역삼동",
    "서울 101동 강남대로 123",
    "서울 101동1001호 강남대로 123",
    "서울 지하1층 강남대로 123",
    "서울 강남구 테헤란로 123 101동 1001호",
    "서울 강남구 테헤란로 123 3층",
  ]) {
    assert.equal(isValidApplicantRoadAddress!(value), false, `${value} should be invalid`);
  }
});

test("postcode selection accepts only the provider's road-address field", async () => {
  const applicantFormModule = await loadApplicantFormModule();
  const applicantRoadAddressFromPostcode = applicantFormModule.applicantRoadAddressFromPostcode as
    | ((value: unknown) => string | null)
    | undefined;

  assert.equal(typeof applicantRoadAddressFromPostcode, "function");
  assert.equal(applicantRoadAddressFromPostcode!({
    roadAddress: " 서울 강남구 테헤란로 123 ",
    address: "서울 강남구 역삼동 123",
  }), "서울 강남구 테헤란로 123");
  assert.equal(applicantRoadAddressFromPostcode!({
    roadAddress: "",
    autoRoadAddress: "서울 서초구 서초대로77길 54",
  }), null);
  assert.equal(applicantRoadAddressFromPostcode!({
    roadAddress: "",
    address: "서울 강남구 역삼동 123",
  }), null);
  assert.equal(applicantRoadAddressFromPostcode!(null), null);
});

test("validation explains how to recover from an impossible birth date", async () => {
  const applicantFormModule = await loadApplicantFormModule();
  const validateApplicantForm = applicantFormModule.validateApplicantForm as
    | ((form: ApplicantFormData) => { field: keyof ApplicantFormData; message: string } | null)
    | undefined;

  assert.equal(typeof validateApplicantForm, "function");
  assert.deepEqual(validateApplicantForm!({
    ...EMPTY_FORM,
    name: "김지원",
    birthDate: "991332",
  }), {
    field: "birthDate",
    message: "생년월일을 확인해주세요. 예: 1960년 1월 1일은 600101입니다.",
  });
});

test("validation points to the first invalid field with a recovery message", async () => {
  const applicantFormModule = await loadApplicantFormModule();
  const validateApplicantForm = applicantFormModule.validateApplicantForm as
    | ((form: ApplicantFormData) => { field: keyof ApplicantFormData; message: string } | null)
    | undefined;

  assert.equal(typeof validateApplicantForm, "function");
  assert.deepEqual(
    validateApplicantForm!({
      ...EMPTY_FORM,
      name: "김지원",
      birthDate: "600101",
      phone: "0101234",
    }),
    {
      field: "phone",
      message: "연락처를 정확히 입력해주세요.",
    },
  );
});

test("a complete valid form reaches 100 percent and passes validation", async () => {
  const applicantFormModule = await loadApplicantFormModule();
  const applicantFormProgress = applicantFormModule.applicantFormProgress as
    | ((form: ApplicantFormData) => { completed: number; total: number; percent: number })
    | undefined;
  const validateApplicantForm = applicantFormModule.validateApplicantForm as
    | ((form: ApplicantFormData) => { field: keyof ApplicantFormData; message: string } | null)
    | undefined;
  const completeForm: ApplicantFormData = {
    ...EMPTY_FORM,
    name: "김지원",
    birthDate: "600101",
    phone: "01012345678",
    location: "서울 강남구 테헤란로 123",
    ownVehicle: "있음",
    licenseType: "1종 보통",
    vehicleType: "승용차",
    branch1: "강남점",
    workHours: ["평일 오전"],
    availableDate: "2026-08-20",
    selfOwnership: "문제 없음",
    marketingConsent: false,
  };

  assert.equal(typeof applicantFormProgress, "function");
  assert.equal(typeof validateApplicantForm, "function");
  assert.deepEqual(applicantFormProgress!(completeForm), { completed: 12, total: 12, percent: 100 });
  assert.equal(validateApplicantForm!(completeForm), null);
});

test("vehicle type is required only after the applicant says they own a vehicle", async () => {
  const applicantFormModule = await loadApplicantFormModule();
  const applicantFormProgress = applicantFormModule.applicantFormProgress as
    | ((form: ApplicantFormData) => { completed: number; total: number; percent: number })
    | undefined;
  const validateApplicantForm = applicantFormModule.validateApplicantForm as
    | ((form: ApplicantFormData) => { field: keyof ApplicantFormData; message: string } | null)
    | undefined;
  const otherwiseComplete: ApplicantFormData = {
    ...EMPTY_FORM,
    name: "김지원",
    birthDate: "600101",
    phone: "01012345678",
    location: "서울 강남구 테헤란로 123",
    licenseType: "1종 보통",
    branch1: "강남점",
    workHours: ["평일 오전"],
    availableDate: "2026-08-20",
    selfOwnership: "문제 없음",
    marketingConsent: false,
  };

  assert.deepEqual(validateApplicantForm!({
    ...otherwiseComplete,
    ownVehicle: "있음",
    licenseType: "",
    vehicleType: "",
  }), { field: "vehicleType", message: "배송에 사용할 차량 모델명을 입력해주세요." });
  assert.deepEqual(validateApplicantForm!({
    ...otherwiseComplete,
    ownVehicle: "있음",
    licenseType: "",
    vehicleType: "포터",
  }), { field: "licenseType", message: "운전면허 종류를 선택해주세요." });
  assert.deepEqual(validateApplicantForm!({
    ...otherwiseComplete,
    ownVehicle: "있음",
  }), { field: "vehicleType", message: "배송에 사용할 차량 모델명을 입력해주세요." });
  assert.equal(validateApplicantForm!({
    ...otherwiseComplete,
    ownVehicle: "없음",
  }), null);
  assert.deepEqual(applicantFormProgress!({
    ...otherwiseComplete,
    ownVehicle: "없음",
  }), { completed: 11, total: 11, percent: 100 });
});

test("new-job SMS consent requires a decision but never requires agreement", async () => {
  const applicantFormModule = await loadApplicantFormModule();
  const validateApplicantForm = applicantFormModule.validateApplicantForm as
    | ((form: ApplicantFormData) => { field: keyof ApplicantFormData; message: string } | null)
    | undefined;
  const otherwiseComplete: ApplicantFormData = {
    ...EMPTY_FORM,
    name: "김지원",
    birthDate: "600101",
    phone: "01012345678",
    location: "서울 강남구 테헤란로 123",
    ownVehicle: "없음",
    licenseType: "없음",
    branch1: "강남점",
    workHours: ["평일 오전"],
    availableDate: "2026-08-20",
    selfOwnership: "문제 없음",
  };

  assert.deepEqual(validateApplicantForm!(otherwiseComplete), {
    field: "marketingConsent",
    message: "새 일자리 문자 수신 여부를 선택해주세요.",
  });
  assert.equal(validateApplicantForm!({ ...otherwiseComplete, marketingConsent: false }), null);
  assert.equal(validateApplicantForm!({ ...otherwiseComplete, marketingConsent: true }), null);
});
