export type PoolAvailabilityAction = "interest" | "notify" | "immediate";

export const IMMEDIATE_AVAILABILITY_COPY = {
  question: "오늘이나 내일부터 바로 일할 수 있으신가요?",
  answer: "네, 오늘이나 내일부터 가능해요",
} as const;

/** 일반 관심·다음 기회 알림은 전역 가용성 신호가 아니다. */
export function poolAvailabilityDecision(
  currentAvailability: string | null,
  action: PoolAvailabilityAction,
): { nextAvailability: "즉시가능" } | null {
  if (action !== "immediate" || currentAvailability === "즉시가능") return null;
  return { nextAvailability: "즉시가능" };
}
