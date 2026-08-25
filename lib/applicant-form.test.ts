import assert from "node:assert/strict";
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
  marketingConsent: boolean;
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
  marketingConsent: false,
};

async function loadApplicantFormModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./applicant-form.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("required progress starts at zero and ignores optional answers", async () => {
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
    { completed: 0, total: 11, percent: 0 },
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
    { completed: 3, total: 11, percent: 27 },
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
    location: "서울시 강남구",
    ownVehicle: "있음",
    licenseType: "1종 보통",
    vehicleType: "승용차",
    branch1: "강남점",
    workHours: ["평일 오전"],
    availableDate: "2026-08-20",
    selfOwnership: "문제 없음",
  };

  assert.equal(typeof applicantFormProgress, "function");
  assert.equal(typeof validateApplicantForm, "function");
  assert.deepEqual(applicantFormProgress!(completeForm), { completed: 11, total: 11, percent: 100 });
  assert.equal(validateApplicantForm!(completeForm), null);
});
