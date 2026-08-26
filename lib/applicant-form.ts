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
  marketingConsent: boolean | null;
}

export const APPLICANT_SETTLEMENT_ACCOUNT_OPTIONS = [
  { value: "문제 없음", label: "네, 가능해요" },
  { value: "문제 있음", label: "아니요, 어려워요" },
] as const;

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
  | "selfOwnership"
  | "marketingConsent";

export interface ApplicantValidationIssue {
  field: RequiredApplicantField;
  message: string;
}

export const APPLICANT_BIRTH_DATE_ERROR_MESSAGE =
  "생년월일을 확인해주세요. 예: 1960년 1월 1일은 600101입니다.";

export const APPLICANT_ROAD_ADDRESS_ERROR_MESSAGE =
  "도로명과 건물번호까지만 입력해주세요. 예: 서울 강남구 테헤란로 123 (동·호수 제외)";

export function isValidApplicantBirthDate(value: string): boolean {
  if (!/^\d{6}$/.test(value)) return false;
  const year = 2000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function normalizeApplicantRoadAddress(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isValidApplicantRoadAddress(value: string): boolean {
  const normalized = normalizeApplicantRoadAddress(value);
  if (/(?:^|\s)(?:지하|지상)?\d+\s*(?:동|호|층)/u.test(normalized)) return false;
  return /^[가-힣A-Za-z0-9·().\-\s]+(?:대로|로|길)\s+(?:지하\s*)?\d+(?:-\d+)?$/u.test(normalized);
}

export function applicantRoadAddressFromPostcode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const candidate = typeof record.roadAddress === "string" ? record.roadAddress : "";
  const normalized = normalizeApplicantRoadAddress(candidate);
  return isValidApplicantRoadAddress(normalized) ? normalized : null;
}

type ApplicantRequirement = ApplicantValidationIssue & {
  isValid: (form: ApplicantFormData) => boolean;
};

const BASE_REQUIREMENTS: ApplicantRequirement[] = [
  { field: "name", message: "이름을 입력해주세요.", isValid: (form) => Boolean(form.name.trim()) },
  { field: "birthDate", message: APPLICANT_BIRTH_DATE_ERROR_MESSAGE, isValid: (form) => isValidApplicantBirthDate(form.birthDate) },
  { field: "phone", message: "연락처를 정확히 입력해주세요.", isValid: (form) => /^\d{10,11}$/.test(form.phone) },
  { field: "location", message: APPLICANT_ROAD_ADDRESS_ERROR_MESSAGE, isValid: (form) => isValidApplicantRoadAddress(form.location) },
  { field: "ownVehicle", message: "자차 보유 여부를 선택해주세요.", isValid: (form) => form.ownVehicle === "있음" || form.ownVehicle === "없음" },
];

const VEHICLE_TYPE_REQUIREMENT: ApplicantRequirement =
  { field: "vehicleType", message: "배송에 사용할 차량 모델명을 입력해주세요.", isValid: (form) => Boolean(form.vehicleType.trim()) };

const LICENSE_TYPE_REQUIREMENT: ApplicantRequirement =
  { field: "licenseType", message: "운전면허 종류를 선택해주세요.", isValid: (form) => Boolean(form.licenseType) };

const FINAL_REQUIREMENTS: ApplicantRequirement[] = [
  { field: "branch1", message: "희망 지점을 선택해주세요.", isValid: (form) => Boolean(form.branch1) },
  { field: "workHours", message: "희망 근무 시간대를 1개 이상 선택해주세요.", isValid: (form) => form.workHours.length > 0 },
  { field: "availableDate", message: "근무 가능 시작일을 선택해주세요.", isValid: (form) => Boolean(form.availableDate) },
  { field: "selfOwnership", message: "정산계좌 본인 명의 가능 여부를 선택해주세요.", isValid: (form) => Boolean(form.selfOwnership) },
  { field: "marketingConsent", message: "새 일자리 문자 수신 여부를 선택해주세요.", isValid: (form) => typeof form.marketingConsent === "boolean" },
];

function applicantRequirements(form: ApplicantFormData): ApplicantRequirement[] {
  return [
    ...BASE_REQUIREMENTS,
    ...(form.ownVehicle === "있음" ? [VEHICLE_TYPE_REQUIREMENT] : []),
    LICENSE_TYPE_REQUIREMENT,
    ...FINAL_REQUIREMENTS,
  ];
}

export function validateApplicantForm(form: ApplicantFormData): ApplicantValidationIssue | null {
  const invalid = applicantRequirements(form).find((requirement) => !requirement.isValid(form));
  return invalid ? { field: invalid.field, message: invalid.message } : null;
}

export function applicantFormProgress(form: ApplicantFormData): {
  completed: number;
  total: number;
  percent: number;
} {
  const requirements = applicantRequirements(form);
  const completed = requirements.filter((requirement) => requirement.isValid(form)).length;
  const total = requirements.length;

  return {
    completed,
    total,
    percent: Math.round((completed / total) * 100),
  };
}
