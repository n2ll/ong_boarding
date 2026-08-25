interface ApplicantPostcodeEmbedder {
  embed(container: HTMLElement): void;
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
