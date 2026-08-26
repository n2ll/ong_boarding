import { isValidApplicantRoadAddress } from "./applicant-form.ts";

interface ApplicantPostcodeEmbedder {
  embed(container: HTMLElement): void;
}

export type ApplicantPostcodePresentation = {
  mode: "search" | "selected" | "manual";
  actionLabel: string;
  statusMessage: string | null;
};

export function applicantPostcodeBlocksSubmission(
  lookupState: "idle" | "loading" | "error",
  searchOpen: boolean,
): boolean {
  return lookupState === "loading" || searchOpen;
}

export function applicantPostcodePresentation(
  address: string,
  manualEntry: boolean,
): ApplicantPostcodePresentation {
  if (manualEntry || (address !== "" && !isValidApplicantRoadAddress(address))) {
    return {
      mode: "manual",
      actionLabel: "주소 검색 사용하기",
      statusMessage: null,
    };
  }
  if (address) {
    return {
      mode: "selected",
      actionLabel: "주소 변경",
      statusMessage: `주소 선택 완료: ${address}`,
    };
  }
  return {
    mode: "search",
    actionLabel: "주소 검색해서 선택하기",
    statusMessage: null,
  };
}

export function embedApplicantPostcode(input: {
  container: HTMLElement;
  create: () => ApplicantPostcodeEmbedder;
  onError: () => void;
}): boolean {
  try {
    input.create().embed(input.container);
    return true;
  } catch {
    input.onError();
    return false;
  }
}
