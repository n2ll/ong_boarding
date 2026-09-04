import {
  matchesRule,
  type ExposureApplicant,
  type ExposureRule,
} from "../exposure.ts";
import { distanceToJobKm, type GeoJob } from "../geo.ts";
import { normalizePhone } from "../ongmanaging.ts";
import { distanceScore, recencyScore, vehicleScore } from "../scoring.ts";

const SMS_EXCLUDED_STATUSES = new Set(["부적합", "이탈", "확정인력"]);

export interface AudiencePreviewApplicant extends ExposureApplicant {
  name: string | null;
  phone: string | null;
  access_token: string | null;
  status: string | null;
  sms_opt_out_at: string | null;
  marketing_consent: boolean | null;
}

export interface AudienceRecommendation {
  applicant_id: number;
  name: string | null;
  availability: string | null;
  own_vehicle: string | null;
  distance_km: number | null;
  reasons: string[];
  sms_eligible: boolean;
}

interface SelectJobAudiencePreviewArgs {
  applicants: AudiencePreviewApplicant[];
  exposure: "all" | "targeted";
  rule: ExposureRule | null;
  job: GeoJob | null;
  vehicleRequired: boolean;
  nowMs?: number;
  blacklistedPhones?: Set<string>;
  guardedPhones?: Set<string>;
}

interface RankedApplicant {
  applicant: AudiencePreviewApplicant;
  distanceKm: number | null;
  score: number;
  smsEligible: boolean;
  identityKey: string;
}

function normalizedSmsPhone(applicant: AudiencePreviewApplicant): string | null {
  const phone = normalizePhone(applicant.phone ?? "");
  return /^\d{10,11}$/.test(phone) ? phone : null;
}

function applicantRecommendationReasons(
  applicant: AudiencePreviewApplicant,
  distanceKm: number | null,
  vehicleRequired: boolean,
  nowMs: number,
): string[] {
  const reasons: string[] = [];
  if (distanceKm !== null) reasons.push(`거리 ${distanceKm.toFixed(1)}km`);
  if (vehicleRequired && applicant.own_vehicle === "있음") reasons.push("차량 요건 충족");
  if (applicant.availability?.trim()) reasons.push(`가용성 ${applicant.availability.trim()}`);
  const recencyAt = applicant.applied_at ?? applicant.created_at;
  const recencyTime = recencyAt ? new Date(recencyAt).getTime() : Number.NaN;
  if (Number.isFinite(recencyTime)) {
    const days = Math.max(0, (nowMs - recencyTime) / 86400000);
    if (days <= 30) reasons.push("최근 지원 30일 이내");
    else if (days <= 90) reasons.push("최근 지원 90일 이내");
  }
  return reasons;
}

export function selectJobAudiencePreview({
  applicants,
  exposure,
  rule,
  job,
  vehicleRequired,
  nowMs = Date.now(),
  blacklistedPhones = new Set<string>(),
  guardedPhones = new Set<string>(),
}: SelectJobAudiencePreviewArgs): {
  visibleCount: number;
  smsEligibleCount: number;
  recommendations: AudienceRecommendation[];
} {
  const visible = exposure === "all"
    ? applicants
    : applicants.filter((applicant) => matchesRule(applicant, rule, { nowMs, job }));

  const rowsByPhone = new Map<string, AudiencePreviewApplicant[]>();
  for (const applicant of applicants) {
    const phone = normalizedSmsPhone(applicant);
    if (!phone) continue;
    const rows = rowsByPhone.get(phone) ?? [];
    rows.push(applicant);
    rowsByPhone.set(phone, rows);
  }

  const smsEligibleApplicantIds = new Set<number>();
  const smsEligiblePhones = new Set<string>();
  for (const applicant of visible) {
    const phone = normalizedSmsPhone(applicant);
    if (!phone || smsEligiblePhones.has(phone)) continue;
    const identityRows = rowsByPhone.get(phone) ?? [applicant];
    const identityBlocked = identityRows.some((row) => (
      Boolean(row.sms_opt_out_at) || SMS_EXCLUDED_STATUSES.has(row.status ?? "")
    ));
    if (
      identityBlocked
      || blacklistedPhones.has(phone)
      || guardedPhones.has(phone)
      || !applicant.access_token
      || applicant.marketing_consent !== true
    ) {
      continue;
    }
    smsEligiblePhones.add(phone);
    smsEligibleApplicantIds.add(applicant.id);
  }

  const ranked: RankedApplicant[] = visible.map((applicant) => {
    const distanceKm = distanceToJobKm(applicant, job);
    const phone = normalizedSmsPhone(applicant);
    return {
      applicant,
      distanceKm,
      score:
        (distanceKm === null ? 0 : distanceScore(distanceKm))
        + vehicleScore(applicant.own_vehicle, vehicleRequired)
        + recencyScore(applicant.applied_at ?? applicant.created_at),
      smsEligible: smsEligibleApplicantIds.has(applicant.id),
      identityKey: phone ? `phone:${phone}` : `applicant:${applicant.id}`,
    };
  }).sort((left, right) => (
    right.score - left.score
    || (left.distanceKm ?? Number.POSITIVE_INFINITY) - (right.distanceKm ?? Number.POSITIVE_INFINITY)
    || left.applicant.id - right.applicant.id
  ));

  const recommendationByIdentity = new Map<string, RankedApplicant>();
  for (const candidate of ranked) {
    const current = recommendationByIdentity.get(candidate.identityKey);
    if (!current || (!current.smsEligible && candidate.smsEligible)) {
      recommendationByIdentity.set(candidate.identityKey, candidate);
    }
  }

  const recommendations = [...recommendationByIdentity.values()]
    .sort((left, right) => (
      right.score - left.score
      || (left.distanceKm ?? Number.POSITIVE_INFINITY) - (right.distanceKm ?? Number.POSITIVE_INFINITY)
      || left.applicant.id - right.applicant.id
    ))
    .slice(0, 5)
    .map(({ applicant, distanceKm, smsEligible }) => ({
      applicant_id: applicant.id,
      name: applicant.name,
      availability: applicant.availability,
      own_vehicle: applicant.own_vehicle ?? null,
      distance_km: distanceKm === null ? null : Math.round(distanceKm * 10) / 10,
      reasons: applicantRecommendationReasons(applicant, distanceKm, vehicleRequired, nowMs),
      sms_eligible: smsEligible,
    }));

  return {
    visibleCount: visible.length,
    smsEligibleCount: smsEligiblePhones.size,
    recommendations,
  };
}
