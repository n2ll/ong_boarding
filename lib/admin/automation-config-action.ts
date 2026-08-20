export type AutomationRuleConfig = Record<string, { enabled: boolean; threshold?: number }>;

type AutomationRequest = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export type AutomationConfigSaveResult =
  | { ok: true; config: AutomationRuleConfig }
  | { ok: false; error: string };

function responseError(body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return "규칙 저장에 실패했어요.";
}

export async function saveAutomationConfig(
  config: AutomationRuleConfig,
  request: AutomationRequest = fetch,
): Promise<AutomationConfigSaveResult> {
  try {
    const response = await request("/api/admin/automation/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) return { ok: false, error: responseError(body) };
    if (!body || typeof body !== "object" || !("config" in body)) {
      return { ok: false, error: "저장 결과를 확인하지 못했어요." };
    }
    return { ok: true, config: body.config as AutomationRuleConfig };
  } catch {
    return { ok: false, error: "규칙 저장에 실패했어요." };
  }
}
