export type DashboardUrgency = "blocker" | "critical" | "attention";

export type DashboardPriorityItem = {
  urgency: DashboardUrgency;
  ageMinutes?: number | null;
  priorityLabel?: string;
};

export type DashboardGatewayPresentation = {
  tone: "healthy" | "attention" | "blocker";
  label: string;
  urgent: {
    urgency: "attention" | "blocker";
    ageMinutes: number | null;
    title: string;
    desc: string;
  } | null;
};

const URGENCY_WEIGHT: Record<DashboardUrgency, number> = {
  blocker: 3,
  critical: 2,
  attention: 1,
};

export function isDashboardPrimaryPriority(
  sourceState: "loading" | "error" | "ready",
  index: number,
): boolean {
  return sourceState === "ready" && index === 0;
}

export function orderDashboardUrgentItems<T extends DashboardPriorityItem>(
  items: readonly T[],
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const urgency = URGENCY_WEIGHT[b.item.urgency] - URGENCY_WEIGHT[a.item.urgency];
      if (urgency !== 0) return urgency;

      const age = (b.item.ageMinutes ?? -1) - (a.item.ageMinutes ?? -1);
      return age !== 0 ? age : a.index - b.index;
    })
    .map(({ item }) => item);
}

export function dashboardQueuePreview<T>(
  items: readonly T[],
  limit = 5,
): { visible: T[]; remaining: number } {
  const safeLimit = Math.max(0, Math.floor(limit));
  return {
    visible: items.slice(0, safeLimit),
    remaining: Math.max(0, items.length - safeLimit),
  };
}

export function oldestUntouchedReplyDays(
  items: readonly {
    agent_stage?: string | null;
    last_message_at?: string | null;
    created_at?: string | null;
  }[],
  now: number,
): number | null {
  let oldest = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (item.agent_stage === "paused") continue;
    const timestamp = new Date(item.last_message_at ?? item.created_at ?? "").getTime();
    if (Number.isFinite(timestamp)) oldest = Math.min(oldest, timestamp);
  }
  return Number.isFinite(oldest)
    ? Math.max(0, Math.floor((now - oldest) / 86_400_000))
    : null;
}

export function dashboardUrgencyLabel(
  item: Pick<DashboardPriorityItem, "urgency" | "priorityLabel">,
): string {
  if (item.priorityLabel) return item.priorityLabel;
  if (item.urgency === "blocker") return "운영 차단";
  if (item.urgency === "critical") return "장기 지연";
  return "확인 필요";
}

export function dashboardGatewayPresentation(input: {
  response?: {
    data?: readonly {
      last_seen_at: string | null;
      pending_count: number;
    }[];
  };
  error?: unknown;
  now: number;
}): DashboardGatewayPresentation | null {
  if (input.error) {
    return {
      tone: "blocker",
      label: "문자폰 상태 확인 실패",
      urgent: {
        urgency: "blocker",
        ageMinutes: null,
        title: "문자 발송폰 상태를 확인할 수 없어요",
        desc: "법인폰 연결 상태를 확인하지 못해 문자 송수신 가능 여부를 알 수 없습니다.",
      },
    };
  }
  if (!input.response) return null;

  const latest = input.response.data?.[0];
  const lastSeenAt = latest?.last_seen_at ? new Date(latest.last_seen_at).getTime() : Number.NaN;
  if (!latest || !Number.isFinite(lastSeenAt)) {
    return {
      tone: "blocker",
      label: "문자 발송폰 신호 없음",
      urgent: {
        urgency: "blocker",
        ageMinutes: null,
        title: "문자 발송폰 신호가 없어요",
        desc: "연결된 법인폰을 확인할 수 없어 문자 송수신이 멈췄을 수 있습니다.",
      },
    };
  }

  const ageMinutes = Math.floor(Math.max(0, input.now - lastSeenAt) / 60_000);
  const ago = ageMinutes < 1 ? "방금" : ageMinutes < 60 ? `${ageMinutes}분 전` : `${Math.floor(ageMinutes / 60)}시간 전`;
  const pendingCount = latest.pending_count ?? 0;
  const label = `문자폰 ${ago} · 대기 ${pendingCount}건`;

  if (ageMinutes >= 10) {
    return {
      tone: "blocker",
      label,
      urgent: {
        urgency: "blocker",
        ageMinutes,
        title: `문자 발송폰이 ${ago}부터 응답하지 않아요`,
        desc: "법인폰 앱과 네트워크 상태를 확인해야 합니다.",
      },
    };
  }
  if (pendingCount > 0) {
    return {
      tone: "attention",
      label,
      urgent: {
        urgency: "attention",
        ageMinutes,
        title: `문자 발송 대기 ${pendingCount}건`,
        desc: "법인폰은 연결돼 있지만 아직 발송되지 않은 문자가 있습니다.",
      },
    };
  }

  return { tone: "healthy", label, urgent: null };
}
