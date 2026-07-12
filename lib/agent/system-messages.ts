/**
 * 시스템 자동 발송용 운영 메시지 조회 헬퍼.
 *
 * prompt_examples 테이블의 category='system_message' row를 title 기준으로 조회.
 * 매니저가 톤가이드/AI 참고자료처럼 admin UI에서 편집할 수 있고,
 * apply route / agent route 등 서버 측이 동일 출처에서 멘트를 가져온다.
 *
 * 사용 키:
 *  - 'danggeun_start'      : 당근 유입 후보에게 첫 발송할 시작 멘트
 *  - 'apply_received'      : apply 폼 접수 안내 (기본 fallback)
 *  - 'screening_announce'  : 스크리닝 진입 시 안내 묶음 (정산·프로모션·업무시간)
 *  - 'onboarding_guide'    : 온보딩 진입 시 앱설치·교육 안내
 *  - 'onboarding_reminder' : 온보딩 가이드 발송 후 24h 미회신 시 cron이 보내는 리마인더
 *  - 'first_day_rules'     : 근무 시작(active) 첫 출근 룰 안내
 *  - 'interest_engage'     : pull '관심 있어요' 자동 응대 첫 문자 ({{이름}}·{{공고명}} 치환)
 *
 * 본문에 {{이름}} placeholder를 쓰면 발송 시 지원자 이름으로 치환됨.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type SystemMessageKey =
  | "danggeun_start"
  | "apply_received"
  | "baemin_apply_invite"
  | "screening_announce"
  | "onboarding_guide"
  | "onboarding_reminder"
  | "first_day_rules"
  | "interest_engage";

/** {{이름}} 등 placeholder 치환 */
export function fillTemplate(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
  }
  return out;
}

export async function getSystemMessage(
  supabase: SupabaseClient,
  key: SystemMessageKey
): Promise<string | null> {
  const { data, error } = await supabase
    .from("prompt_examples")
    .select("body")
    .eq("category", "system_message")
    .eq("title", key)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[system-messages] fetch '${key}' failed`, error);
    return null;
  }
  return (data?.body as string | null) ?? null;
}
