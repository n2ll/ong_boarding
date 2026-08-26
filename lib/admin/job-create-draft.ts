export interface JobCreateChannelDrafts {
  danggeun: string;
  albamon: string;
  sms: string;
}

export interface JobCreateDraftInput {
  prompt: string;
  postingTitle: string;
  channelDrafts: JobCreateChannelDrafts | null;
  clientId: number | "";
  branchId: number | "";
  siteManagerId: number | "";
  recruitModeChanged: boolean;
  capacity: number | "";
  payType: string;
  payInfo: string;
  period: string;
  closesAt: string;
  slot: string;
  slotKeys: readonly string[];
  startDate: string;
  pickupAddress: string;
  dropoffAddress: string;
  vehicleRequirementChanged: boolean;
  policyNotes: string;
  aiFacts: string;
  hasCustomExposure: boolean;
  sosId: string | null;
}

function hasText(value: string | null): boolean {
  return Boolean(value?.trim());
}

/** 알바몬 원문을 우선하되, 공백뿐인 채널은 건너뛰어 실제 작성 본문을 보존한다. */
export function jobCreateDraftBody(channelDrafts: JobCreateChannelDrafts | null): string {
  if (!channelDrafts) return "";
  return [channelDrafts.albamon, channelDrafts.danggeun, channelDrafts.sms]
    .find(hasText)
    ?.trim() ?? "";
}

/**
 * 새 공고 모달을 닫을 때 보호해야 할 실제 작업이 있는지 판정한다.
 *
 * UI 개폐·탭·검증 오류 같은 일시 상태는 받지 않는다. 반대로 복제와 SOS는
 * 기본 폼에 실제 값이 채워지므로 별도 플래그 없이 같은 계약으로 보호된다.
 */
export function hasJobCreateDraft(input: JobCreateDraftInput): boolean {
  const textValues = [
    input.prompt,
    input.postingTitle,
    input.payType,
    input.payInfo,
    input.period,
    input.closesAt,
    input.slot,
    input.startDate,
    input.pickupAddress,
    input.dropoffAddress,
    input.policyNotes,
    input.aiFacts,
  ];

  if (textValues.some(hasText)) return true;
  if (input.channelDrafts && Object.values(input.channelDrafts).some(hasText)) return true;

  return (
    input.clientId !== "" ||
    input.branchId !== "" ||
    input.siteManagerId !== "" ||
    input.recruitModeChanged ||
    input.capacity !== "" ||
    input.slotKeys.length > 0 ||
    input.vehicleRequirementChanged ||
    input.hasCustomExposure ||
    hasText(input.sosId)
  );
}
