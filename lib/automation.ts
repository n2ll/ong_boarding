/**
 * 자동 점검 규칙 엔진 (1단계 실연동).
 *
 * 비주얼 워크플로우 빌더(Automation.tsx 캔버스)는 아직 데모지만,
 * 여기 정의된 규칙들은 실제 라이브 데이터를 평가하고 조건 충족 시 Slack으로 알린다.
 *
 * 저장소: prompt_examples(category='system_message', title='__automation__')에 설정 JSON.
 *   - 신규 테이블/마이그레이션 없이 동작(기존 CHECK 제약 우회용 예약 제목).
 * 실행: /api/admin/automation/evaluate (수동 '지금 점검')
 *       + /api/admin/cron/automation-evaluate (매시 30분 정기 실행).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSlackText } from "@/lib/slack";
import { isAgentDisabled } from "@/lib/agent/kill-switch";

export type RuleId = "inbox_pending" | "waiting_backlog" | "ai_offline" | "screening_backlog";

/** '스크리닝 전 적체' 판정 기준 경과 시간 (지원 접수 후 N시간) */
const SCREENING_BACKLOG_HOURS = 24;

export interface RuleConfig {
  enabled: boolean;
  threshold?: number;
}

export type AutomationConfig = Record<RuleId, RuleConfig>;

export interface RuleDef {
  id: RuleId;
  label: string;
  desc: string;
  hasThreshold: boolean;
  defaultThreshold?: number;
  unit?: string;
}

export const AUTOMATION_RULES: RuleDef[] = [
  {
    id: "inbox_pending",
    label: "미분류 문자함 적체 알림",
    desc: "분류 대기 중인 수신 문자가 기준치 이상이면 매니저에게 알립니다.",
    hasThreshold: true,
    defaultThreshold: 1,
    unit: "건",
  },
  {
    id: "waiting_backlog",
    label: "대기자 적체 알림",
    desc: "대기자 상태 지원자가 기준치 이상 쌓이면 충원/배치를 알립니다.",
    hasThreshold: true,
    defaultThreshold: 5,
    unit: "명",
  },
  {
    id: "ai_offline",
    label: "AI 자동응답 중단 감지",
    desc: "전역 AI 응답이 꺼져 있으면(수동 응대 부담) 알립니다.",
    hasThreshold: false,
  },
  {
    id: "screening_backlog",
    label: "스크리닝 전 적체 알림",
    desc: `스크리닝 전 상태로 ${SCREENING_BACKLOG_HOURS}시간 넘게 방치된 지원자가 기준치 이상이면 알립니다.`,
    hasThreshold: true,
    defaultThreshold: 3,
    unit: "명",
  },
];

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  inbox_pending: { enabled: true, threshold: 1 },
  waiting_backlog: { enabled: true, threshold: 5 },
  ai_offline: { enabled: true },
  screening_backlog: { enabled: true, threshold: 3 },
};

const CATEGORY = "system_message";
const TITLE = "__automation__";

export function normalizeConfig(raw: unknown): AutomationConfig {
  const base: AutomationConfig = JSON.parse(JSON.stringify(DEFAULT_AUTOMATION_CONFIG));
  if (raw && typeof raw === "object") {
    for (const rule of AUTOMATION_RULES) {
      const incoming = (raw as Record<string, RuleConfig>)[rule.id];
      if (incoming && typeof incoming === "object") {
        base[rule.id] = {
          enabled: typeof incoming.enabled === "boolean" ? incoming.enabled : base[rule.id].enabled,
          threshold:
            rule.hasThreshold && typeof incoming.threshold === "number" && incoming.threshold >= 0
              ? incoming.threshold
              : base[rule.id].threshold,
        };
      }
    }
  }
  return base;
}

export async function loadAutomationConfig(supabase: SupabaseClient): Promise<AutomationConfig> {
  const { data, error } = await supabase
    .from("prompt_examples")
    .select("body")
    .eq("category", CATEGORY)
    .eq("title", TITLE)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.body) return JSON.parse(JSON.stringify(DEFAULT_AUTOMATION_CONFIG));
  try {
    return normalizeConfig(JSON.parse(data.body as string));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_AUTOMATION_CONFIG));
  }
}

export async function saveAutomationConfig(supabase: SupabaseClient, config: AutomationConfig): Promise<void> {
  const body = JSON.stringify(normalizeConfig(config));
  const { data: existing } = await supabase
    .from("prompt_examples")
    .select("id")
    .eq("category", CATEGORY)
    .eq("title", TITLE)
    .limit(1)
    .maybeSingle();
  if (existing?.id) {
    await supabase
      .from("prompt_examples")
      .update({ body, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
  } else {
    await supabase.from("prompt_examples").insert({ category: CATEGORY, title: TITLE, body, sort_order: 0 });
  }
}

const NOTIFY_STATE_TITLE = "__automation_notify_state__";

/**
 * 마지막 Slack 발송 시각. cron 정기 실행의 재알림 쿨다운 판단에 사용한다.
 * (수동 '지금 점검' 버튼은 쿨다운 없이 항상 발송 — 관리자가 명시적으로 요청한 실행이므로)
 */
export async function loadLastNotifiedAt(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from("prompt_examples")
    .select("body")
    .eq("category", CATEGORY)
    .eq("title", NOTIFY_STATE_TITLE)
    .limit(1)
    .maybeSingle();
  if (error || !data?.body) return null;
  try {
    const parsed = JSON.parse(data.body as string) as { last_notified_at?: string };
    return typeof parsed.last_notified_at === "string" ? parsed.last_notified_at : null;
  } catch {
    return null;
  }
}

export async function saveLastNotifiedAt(supabase: SupabaseClient, iso: string): Promise<void> {
  const body = JSON.stringify({ last_notified_at: iso });
  const { data: existing } = await supabase
    .from("prompt_examples")
    .select("id")
    .eq("category", CATEGORY)
    .eq("title", NOTIFY_STATE_TITLE)
    .limit(1)
    .maybeSingle();
  if (existing?.id) {
    await supabase
      .from("prompt_examples")
      .update({ body, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
  } else {
    await supabase
      .from("prompt_examples")
      .insert({ category: CATEGORY, title: NOTIFY_STATE_TITLE, body, sort_order: 0 });
  }
}

export interface RuleResult {
  id: RuleId;
  label: string;
  enabled: boolean;
  triggered: boolean;
  value: number | null;
  threshold: number | null;
  detail: string;
}

export interface EvaluateResult {
  ran_at: string;
  results: RuleResult[];
  triggered_count: number;
  notified: boolean;
}

/**
 * 규칙을 라이브 데이터로 평가하고, 트리거된 규칙이 있으면(그리고 notify=true) Slack으로 1회 통합 발송.
 */
export async function evaluateAutomation(
  supabase: SupabaseClient,
  config: AutomationConfig,
  opts: { notify: boolean }
): Promise<EvaluateResult> {
  // 라이브 집계
  const [inboxRes, applicantsRes, aiDisabled] = await Promise.all([
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("classification", "pending")
      .eq("direction", "inbound"),
    supabase.from("applicants").select("status, created_at, source"),
    isAgentDisabled(supabase).catch(() => false),
  ]);

  const inboxCount = inboxRes.count ?? 0;
  const applicants = (applicantsRes.data ?? []) as {
    status: string;
    created_at: string | null;
    source: string | null;
  }[];
  const waitingCount = applicants.filter((a) => a.status === "대기자").length;

  // 스크리닝 전 적체 — 접수 후 N시간이 지나도록 '스크리닝 전' 그대로인 지원자 수.
  // 재활용 편입(source='reengagement')은 의도적으로 파킹된 후보라 적체 알림 대상에서 제외한다.
  const backlogCutoffMs = Date.now() - SCREENING_BACKLOG_HOURS * 60 * 60 * 1000;
  const screeningBacklogCount = applicants.filter(
    (a) =>
      a.status === "스크리닝 전" &&
      a.source !== "reengagement" &&
      a.created_at &&
      new Date(a.created_at).getTime() < backlogCutoffMs
  ).length;

  const results: RuleResult[] = [];

  for (const rule of AUTOMATION_RULES) {
    const rc = config[rule.id];
    let value: number | null = null;
    let threshold: number | null = null;
    let triggered = false;
    let detail = "";

    if (rule.id === "inbox_pending") {
      value = inboxCount;
      threshold = rc.threshold ?? rule.defaultThreshold ?? 1;
      triggered = rc.enabled && value >= threshold;
      detail = `미분류 ${value}건 (기준 ${threshold}건)`;
    } else if (rule.id === "waiting_backlog") {
      value = waitingCount;
      threshold = rc.threshold ?? rule.defaultThreshold ?? 5;
      triggered = rc.enabled && value >= threshold;
      detail = `대기자 ${value}명 (기준 ${threshold}명)`;
    } else if (rule.id === "ai_offline") {
      triggered = rc.enabled && aiDisabled;
      detail = aiDisabled ? "AI 자동응답이 중단된 상태" : "AI 자동응답 정상 작동";
    } else if (rule.id === "screening_backlog") {
      value = screeningBacklogCount;
      threshold = rc.threshold ?? rule.defaultThreshold ?? 3;
      triggered = rc.enabled && value >= threshold;
      detail = `스크리닝 전 ${SCREENING_BACKLOG_HOURS}시간 초과 ${value}명 (기준 ${threshold}명)`;
    }

    results.push({ id: rule.id, label: rule.label, enabled: rc.enabled, triggered, value, threshold, detail });
  }

  const triggeredRules = results.filter((r) => r.triggered);
  let notified = false;

  if (opts.notify && triggeredRules.length > 0) {
    const lines = [
      "🤖 *자동 점검 — 조치 필요 항목*",
      ...triggeredRules.map((r) => `> • *${r.label}:* ${r.detail}`),
      "관리자 페이지에서 확인해주세요.",
    ];
    notified = await sendSlackText(lines.join("\n"));
  }

  return {
    ran_at: new Date().toISOString(),
    results,
    triggered_count: triggeredRules.length,
    notified,
  };
}
