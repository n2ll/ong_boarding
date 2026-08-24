export type NotificationQueryFailure = {
  ok: false;
  failed: string[];
  cause: unknown;
};

export type NotificationQuerySuccess = {
  ok: true;
  inboxCount: number;
  inboxOldestRows: unknown[];
  handoffRows: unknown[];
  killSwitchBody: string | null;
};

export type NotificationQueryState = NotificationQueryFailure | NotificationQuerySuccess;

type QueryResult = { data?: unknown; error?: unknown };

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function killSwitchBody(data: unknown): string | null | undefined {
  if (data === null) return null;
  if (!data || typeof data !== "object" || !("body" in data)) return undefined;
  const body = (data as { body?: unknown }).body;
  return typeof body === "string" || body === null ? body : undefined;
}

/**
 * 알림 집계는 오류뿐 아니라 불완전한 200 응답도 실패로 취급한다.
 * 여기서 검증·추출을 함께 해 라우트가 `?? 0` 또는 `?? []`로 다시 축약하지 못하게 한다.
 */
export function notificationQueryState(input: {
  inbox: QueryResult & { count?: number | null };
  inboxOldest: QueryResult;
  handoffs: QueryResult;
  killSwitch: QueryResult;
}): NotificationQueryState {
  const parsedKillSwitchBody = killSwitchBody(input.killSwitch.data);
  const checks: Array<[string, boolean, unknown]> = [
    ["inbox", !input.inbox.error && isNonNegativeInteger(input.inbox.count), input.inbox.error],
    ["inboxOldest", !input.inboxOldest.error && Array.isArray(input.inboxOldest.data), input.inboxOldest.error],
    ["handoffs", !input.handoffs.error && Array.isArray(input.handoffs.data), input.handoffs.error],
    ["killSwitch", !input.killSwitch.error && parsedKillSwitchBody !== undefined, input.killSwitch.error],
  ];
  const failedChecks = checks.filter(([, valid]) => !valid);

  if (failedChecks.length > 0) {
    const [firstName, , firstError] = failedChecks[0];
    return {
      ok: false,
      failed: failedChecks.map(([name]) => name),
      cause: firstError || `${firstName} 응답 형식이 올바르지 않습니다.`,
    };
  }

  return {
    ok: true,
    inboxCount: input.inbox.count as number,
    inboxOldestRows: input.inboxOldest.data as unknown[],
    handoffRows: input.handoffs.data as unknown[],
    killSwitchBody: parsedKillSwitchBody as string | null,
  };
}

export function notificationAiDisabled(envForced: boolean, body: string | null): boolean {
  return envForced || (body ?? "").trim() === "1";
}
