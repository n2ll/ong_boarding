export interface ApplicantFormData {
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
}

export type RequiredApplicantField =
  | "name"
  | "birthDate"
  | "phone"
  | "location"
  | "ownVehicle"
  | "licenseType"
  | "vehicleType"
  | "branch1"
  | "workHours"
  | "availableDate"
  | "selfOwnership";

export interface ApplicantValidationIssue {
  field: RequiredApplicantField;
  message: string;
}

const REQUIREMENTS: Array<ApplicantValidationIssue & { isValid: (form: ApplicantFormData) => boolean }> = [
  { field: "name", message: "이름을 입력해주세요.", isValid: (form) => Boolean(form.name.trim()) },
  { field: "birthDate", message: "생년월일 6자리(예: 600101)를 입력해주세요.", isValid: (form) => /^\d{6}$/.test(form.birthDate) },
  { field: "phone", message: "연락처를 정확히 입력해주세요.", isValid: (form) => /^\d{10,11}$/.test(form.phone) },
  { field: "location", message: "거주지 주소를 입력해주세요.", isValid: (form) => Boolean(form.location.trim()) },
  { field: "ownVehicle", message: "자차 보유 여부를 선택해주세요.", isValid: (form) => Boolean(form.ownVehicle) },
  { field: "licenseType", message: "운전면허 종류를 선택해주세요.", isValid: (form) => Boolean(form.licenseType) },
  { field: "vehicleType", message: "이동 수단을 입력해주세요.", isValid: (form) => Boolean(form.vehicleType.trim()) },
  { field: "branch1", message: "희망 지점을 선택해주세요.", isValid: (form) => Boolean(form.branch1) },
  { field: "workHours", message: "희망 근무 시간대를 1개 이상 선택해주세요.", isValid: (form) => form.workHours.length > 0 },
  { field: "availableDate", message: "근무 가능 시작일을 선택해주세요.", isValid: (form) => Boolean(form.availableDate) },
  { field: "selfOwnership", message: "본인 명의 가능 여부를 선택해주세요.", isValid: (form) => Boolean(form.selfOwnership) },
];

export function validateApplicantForm(form: ApplicantFormData): ApplicantValidationIssue | null {
  const invalid = REQUIREMENTS.find((requirement) => !requirement.isValid(form));
  return invalid ? { field: invalid.field, message: invalid.message } : null;
}

export function applicantFormProgress(form: ApplicantFormData): {
  completed: number;
  total: number;
  percent: number;
} {
  const completed = REQUIREMENTS.filter((requirement) => requirement.isValid(form)).length;
  const total = REQUIREMENTS.length;

  return {
    completed,
    total,
    percent: Math.round((completed / total) * 100),
  };
}
