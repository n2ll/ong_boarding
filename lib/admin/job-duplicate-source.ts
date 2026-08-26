export type JobDuplicateSource = {
  title: string;
  body: string;
  channelBodies: { danggeun?: string; albamon?: string; sms?: string } | null;
  clientId: number | null;
  branchId: number | null;
  siteManagerId: number | null;
  recruitMode: "external" | "internal" | "both";
  exposure: "all" | "targeted";
  exposureRule: unknown;
  capacity: number | null;
  payType: string;
  payAmount: number | null;
  workPeriod: string;
  slot: string;
  slotKeys: string[];
  startDate: string;
  pickupAddress: string;
  dropoffAddress: string;
  vehicleRequired: boolean;
  payInfo: string;
  policyNotes: string;
  aiFacts: string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function channelBodies(value: unknown): JobDuplicateSource["channelBodies"] {
  const candidate = record(value);
  const result = {
    ...(typeof candidate.danggeun === "string" ? { danggeun: candidate.danggeun } : {}),
    ...(typeof candidate.albamon === "string" ? { albamon: candidate.albamon } : {}),
    ...(typeof candidate.sms === "string" ? { sms: candidate.sms } : {}),
  };
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * 등록 POST/상세 GET의 전체 DB 행에서 다음 공고에 재사용할 값만 남긴다.
 * 기존 id·멱등 키·좌표·상태·SOS 연결은 새 공고로 복제하지 않는다.
 */
export function jobDuplicateSource(value: unknown): JobDuplicateSource {
  const job = record(value);
  return {
    title: stringValue(job.title),
    body: stringValue(job.body),
    channelBodies: channelBodies(job.channel_bodies),
    clientId: numberValue(job.client_id),
    branchId: numberValue(job.branch_id),
    siteManagerId: numberValue(job.site_manager_id),
    recruitMode: job.recruit_mode === "internal" || job.recruit_mode === "both"
      ? job.recruit_mode
      : "external",
    exposure: job.exposure === "targeted" ? "targeted" : "all",
    exposureRule: job.exposure_rule ?? null,
    capacity: numberValue(job.capacity),
    payType: stringValue(job.pay_type),
    payAmount: numberValue(job.pay_amount),
    workPeriod: stringValue(job.work_period),
    slot: stringValue(job.slot),
    slotKeys: Array.isArray(job.slot_keys)
      ? job.slot_keys.filter((key): key is string => typeof key === "string")
      : [],
    startDate: stringValue(job.start_date),
    pickupAddress: stringValue(job.pickup_address),
    dropoffAddress: stringValue(job.dropoff_address),
    vehicleRequired: job.vehicle_required !== false,
    payInfo: stringValue(job.pay_info),
    policyNotes: stringValue(job.policy_notes),
    aiFacts: stringValue(job.ai_facts),
  };
}
