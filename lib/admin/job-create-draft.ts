export interface JobCreateChannelDrafts {
  /** 과거 저장본 읽기 전용. 신규 생성·저장에서는 빈 문자열로 정규화한다. */
  danggeun: string;
  albamon: string;
  sms: string;
}

export interface JobCreatePersistedChannelBodies {
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

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasText(value: unknown): boolean {
  return Boolean(textValue(value));
}

/**
 * 신규 공고 작성 화면이 쓰는 지원 채널로 정규화한다.
 *
 * 예전 공고가 당근 본문만 저장한 경우에도 복제 내용은 잃지 않지만, 이후 화면과
 * 저장 페이로드에서는 당근을 다시 활성 채널로 만들지 않는다.
 */
export function normalizeJobCreateChannelDrafts(
  channelDrafts: unknown,
): JobCreateChannelDrafts {
  const source = channelDrafts !== null && typeof channelDrafts === "object" && !Array.isArray(channelDrafts)
    ? channelDrafts as Record<string, unknown>
    : {};
  const legacyBody = textValue(source.danggeun);
  return {
    danggeun: "",
    albamon: textValue(source.albamon) || legacyBody,
    sms: textValue(source.sms) || legacyBody,
  };
}

/** 신규 공고 DB 저장에는 실제 지원하는 공고 원문과 문자 안내만 남긴다. */
export function jobCreatePersistedChannelBodies(
  channelDrafts: unknown,
): JobCreatePersistedChannelBodies {
  const normalized = normalizeJobCreateChannelDrafts(channelDrafts);
  return { albamon: normalized.albamon, sms: normalized.sms };
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
