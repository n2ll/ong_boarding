export interface JobCreateCompensationInput {
  payType: string;
  payAmount: number | "";
  payInfo: string;
}

export interface JobCreateValidationIssue {
  field: "capacity" | "payInfo" | "pickupAddress" | "dropoffAddress";
  message: string;
}

export interface JobCreateWorkLocationInput {
  pickupAddress: string;
  dropoffAddress: string;
}

export interface JobRequiredFieldsInput
  extends JobCreateCompensationInput,
    JobCreateWorkLocationInput {
  capacity: number | "";
}

export function validateJobCreateCapacity(
  capacity: number | "",
): JobCreateValidationIssue | null {
  if (capacity === "" || !Number.isSafeInteger(capacity) || capacity < 1) {
    return {
      field: "capacity",
      message: "모집 인원을 1명 이상 입력해주세요.",
    };
  }

  return null;
}

export function validateJobCreateCompensation({
  payInfo,
}: JobCreateCompensationInput): JobCreateValidationIssue | null {
  if (!payInfo.trim()) {
    return {
      field: "payInfo",
      message: "지원자에게 안내할 급여·정산 내용을 입력해주세요.",
    };
  }

  return null;
}

export function validateJobCreateWorkLocation({
  pickupAddress,
  dropoffAddress,
}: JobCreateWorkLocationInput): JobCreateValidationIssue | null {
  if (!pickupAddress.trim()) {
    return {
      field: "pickupAddress",
      message: "이번 공고의 상차지·집결지를 입력해주세요.",
    };
  }

  if (!dropoffAddress.trim()) {
    return {
      field: "dropoffAddress",
      message: "이번 공고의 배송 권역 또는 마지막 경유지를 입력해주세요.",
    };
  }

  return null;
}

/** 등록과 수정 화면이 같은 순서·문구로 운영 필수값을 검증한다. */
export function validateJobRequiredFields(
  input: JobRequiredFieldsInput,
): JobCreateValidationIssue | null {
  return (
    validateJobCreateCapacity(input.capacity)
    ?? validateJobCreateWorkLocation(input)
    ?? validateJobCreateCompensation(input)
  );
}
