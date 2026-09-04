import { SLOTS, type SlotKey } from "./types.ts";
import {
  selectJobAudiencePreview,
  type AudiencePreviewApplicant,
} from "./job-audience-preview.ts";
import {
  UNKNOWN_RULE_VALUE,
  type ExposureRule,
} from "../exposure.ts";
import { jobSupportsRadius, type GeoJob } from "../geo.ts";

interface SuggestJobAudienceRuleArgs {
  applicants: AudiencePreviewApplicant[];
  job: GeoJob | null;
  vehicleRequired: boolean;
  slotKeys: string[];
  capacity: number | null;
  nowMs?: number;
  blacklistedPhones?: Set<string>;
  guardedPhones?: Set<string>;
}

export interface JobAudienceSuggestion {
  rule: ExposureRule;
  reasons: string[];
  visibleCount: number;
  smsEligibleCount: number;
  contactTarget: number;
}

const VALID_SLOT_KEYS = new Set<string>(SLOTS);
const RADIUS_OPTIONS_KM = [5, 10, 15, 20, 30] as const;

/**
 * 공고의 확정 사실과 현재 연락 가능 인원을 함께 보고, 지나치게 좁지 않은 노출 규칙을 제안한다.
 * 결과는 미리보기일 뿐이며 저장은 매니저가 화면에서 적용할 때만 일어난다.
 */
export function suggestJobAudienceRule({
  applicants,
  job,
  vehicleRequired,
  slotKeys,
  capacity,
  nowMs = Date.now(),
  blacklistedPhones = new Set<string>(),
  guardedPhones = new Set<string>(),
}: SuggestJobAudienceRuleArgs): JobAudienceSuggestion | null {
  const normalizedSlots = [...new Set(slotKeys.filter((key): key is SlotKey => VALID_SLOT_KEYS.has(key)))];
  const requiredRule: ExposureRule = {};
  const reasons: string[] = [];

  if (vehicleRequired) {
    requiredRule.vehicle = ["있음"];
    reasons.push("차량 보유자");
  }
  let suggestedRule: ExposureRule = { ...requiredRule };
  if (normalizedSlots.length > 0) {
    suggestedRule.slot = [...normalizedSlots, UNKNOWN_RULE_VALUE];
    reasons.push("희망 시간대 일치·미확인 포함");
  }

  const requiredHires = capacity ?? 0;
  const contactTarget = Math.max(requiredHires, Math.min(40, Math.max(10, requiredHires * 4)));
  const preview = (rule: ExposureRule) => selectJobAudiencePreview({
    applicants,
    exposure: "targeted",
    rule,
    job,
    vehicleRequired,
    nowMs,
    blacklistedPhones,
    guardedPhones,
  });

  let suggestedPreview = preview(suggestedRule);

  // 시간대는 선호 조건이라 모집에 필요한 연락 가능 인원을 너무 줄이면 먼저 완화한다.
  // 차량 같은 공고의 필수 요건은 완화하지 않는다.
  if (suggestedPreview.smsEligibleCount < contactTarget && normalizedSlots.length > 0) {
    suggestedRule = { ...requiredRule };
    reasons.pop();
    suggestedPreview = preview(suggestedRule);
  }
  if (suggestedPreview.smsEligibleCount < contactTarget) return null;

  if (jobSupportsRadius(job)) {
    for (const radiusKm of RADIUS_OPTIONS_KM) {
      const radiusRule = { ...suggestedRule, radiusKm, radiusIncludeUnknown: true };
      const radiusPreview = preview(radiusRule);
      if (radiusPreview.smsEligibleCount < contactTarget) continue;
      suggestedRule = radiusRule;
      suggestedPreview = radiusPreview;
      reasons.push(`근무 위치 ${radiusKm}km 이내·주소 미확인 포함`);
      break;
    }
  }

  if (Object.keys(suggestedRule).length === 0 || suggestedPreview.visibleCount === 0) return null;
  return {
    rule: suggestedRule,
    reasons,
    visibleCount: suggestedPreview.visibleCount,
    smsEligibleCount: suggestedPreview.smsEligibleCount,
    contactTarget,
  };
}
