import { createServiceClient } from "@/lib/supabase";
import {
  normalizePhone,
  fetchActiveContractWorkers,
  fetchAllWorkerPhones as ongAllWorkerPhones,
  isOngmanagingConfigured,
} from "@/lib/ongmanaging";
import {
  fetchActiveWorkers as tmsActiveWorkers,
  fetchAllWorkerPhones as tmsAllWorkerPhones,
  isTmsConfigured,
} from "@/lib/tms";
import { fetchBlacklistedPhones } from "@/lib/blacklist";

/**
 * 재활용(재편입) — 옹매니징·TMS 배송원 중 옹보딩 미지원자를 인력풀 후보로 편입.
 *
 * 정책(2026-07-16 확정):
 *  - 대상 = (TMS ∪ 옹매니징) − 블랙리스트 − 기존 옹보딩 지원자.
 *  - **활동 중**(TMS 배차 or 옹매니징 활성계약/지난달정산): 이름+전화 반입 → 바로 기회 안내(+수신거부 고지).
 *  - **비활동**(과거 이력만): 개인정보 미반입, 집계 수치로만. 옵트인 동의 후에만 반입·안내.
 *  - **킬스위치 게이팅**: 편입(import)은 스위치 ON일 때만. 기본 OFF → 미리보기(preview)만 가능.
 *    (실발송은 편입된 후보에게 기존 가드된 발송 플로로 진행 — 블랙리스트·수신거부 하드 가드 그대로 적용.)
 *  - ⚠️ 비지원자 발송의 법적 근거는 실운영 전 검토 필요.
 */

// ── 킬스위치: prompt_examples(category='system_message', title='__reengagement_switch__') body='on'|'off'. 기본 off. ──
const SWITCH_CATEGORY = "system_message";
const SWITCH_TITLE = "__reengagement_switch__";

export async function isReengagementEnabled(): Promise<boolean> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("prompt_examples")
    .select("body")
    .eq("category", SWITCH_CATEGORY)
    .eq("title", SWITCH_TITLE)
    .maybeSingle();
  return (data?.body ?? "off").trim().toLowerCase() === "on";
}

// ── 첫 접촉 문구(자리표시 — 실운영 전 매니저 검토/편집. 확정 뉘앙스 금지) ──
export const REENGAGEMENT_OFFER_TEMPLATE =
  "안녕하세요 #{이름}님, 내이루리 옹보딩입니다. 시간대가 겹치지 않는 추가 배송 라인 기회가 있어 안내드려요. " +
  "관심 있으시면 답장 주세요. 원치 않으시면 '그만'이라고 답주시면 더 안내드리지 않을게요.";
export const REENGAGEMENT_OPTIN_TEMPLATE =
  "안녕하세요, 내이루리 옹보딩입니다. 새 배송 기회가 생기면 먼저 안내드려도 될까요? " +
  "안내받길 원하시면 답장 주세요. 원치 않으시면 무시하셔도 됩니다.";

export interface ReengagementCandidate {
  phone: string;
  name: string | null;
  sources: string[]; // 'tms' | 'ongmanaging'
}
export interface ReengagementSummary {
  configured: boolean;
  enabled: boolean; // 킬스위치
  activeCandidates: ReengagementCandidate[]; // 활동자·미지원·비블랙 (이름+전화)
  activeCount: number;
  inactiveCount: number; // 비활동·미지원·비블랙 (집계만)
  totalEligible: number; // 미지원·비블랙 합집합 전체
  excludedBlacklist: number; // 합집합 중 블랙리스트
  excludedApplicants: number; // 합집합 중 이미 지원자
}

/** 기존 옹보딩 지원자 전화(정규화) 집합 — 페이지네이션 전량. */
async function fetchApplicantPhones(): Promise<Set<string>> {
  const supabase = createServiceClient();
  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("applicants")
      .select("phone")
      .not("phone", "is", null)
      .order("id", { ascending: true }) // 무정렬 페이지네이션은 행 누락 → 이미 지원자를 재편입할 위험
      .range(from, from + 999);
    if (error) {
      // 부분 집합을 조용히 반환하면 이미 지원한 사람을 신규로 오인해 재편입한다 → 던진다(tms-sync 패턴).
      throw new Error(`[reengagement] applicant phones load failed: ${error.message}`);
    }
    const batch = data ?? [];
    for (const r of batch) {
      const p = normalizePhone(String((r as { phone: string | null }).phone ?? ""));
      if (p) out.add(p);
    }
    if (batch.length < 1000) break;
  }
  return out;
}

/** 재활용 후보 발굴 — 읽기 전용(반입·발송 없음). 미리보기·집계용. */
export async function computeReengagementCandidates(): Promise<ReengagementSummary> {
  const configured = isTmsConfigured() || isOngmanagingConfigured();
  const [tmsA, ongA, tmsAll, ongAll, blacklist, appPhones, enabled] = await Promise.all([
    tmsActiveWorkers(),
    fetchActiveContractWorkers(),
    tmsAllWorkerPhones(),
    ongAllWorkerPhones(),
    fetchBlacklistedPhones(),
    fetchApplicantPhones(),
    isReengagementEnabled(),
  ]);

  // 활동자 합집합(이름+전화)
  const activeByPhone = new Map<string, ReengagementCandidate>();
  const addActive = (w: { phone: string; name: string | null }, src: string) => {
    const c = activeByPhone.get(w.phone) ?? { phone: w.phone, name: w.name, sources: [] };
    if (!c.sources.includes(src)) c.sources.push(src);
    if (!c.name && w.name) c.name = w.name;
    activeByPhone.set(w.phone, c);
  };
  for (const w of tmsA) addActive(w, "tms");
  for (const w of ongA) addActive(w, "ongmanaging");

  // 활동 후보 필터: 비블랙 + 미지원
  const activeCandidates: ReengagementCandidate[] = [];
  for (const c of activeByPhone.values()) {
    if (blacklist.has(c.phone) || appPhones.has(c.phone)) continue;
    activeCandidates.push(c);
  }
  activeCandidates.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  // 전체 합집합 대비 집계
  const allUnion = new Set<string>([...tmsAll, ...ongAll]);
  let excludedBlacklist = 0;
  let excludedApplicants = 0;
  let totalEligible = 0;
  for (const p of allUnion) {
    if (blacklist.has(p)) {
      excludedBlacklist++;
      continue;
    }
    if (appPhones.has(p)) {
      excludedApplicants++;
      continue;
    }
    totalEligible++;
  }
  const inactiveCount = Math.max(0, totalEligible - activeCandidates.length);

  return {
    configured,
    enabled,
    activeCandidates,
    activeCount: activeCandidates.length,
    inactiveCount,
    totalEligible,
    excludedBlacklist,
    excludedApplicants,
  };
}

/**
 * 활동 후보 편입(import) — applicants에 최소 필드(이름+전화)로 INSERT. **킬스위치 ON일 때만 호출**.
 * status='스크리닝 전'(중립, AI 자동발송 없음), source='reengagement'. 이미 있는 전화는 스킵(멱등).
 * 반환: 실제 편입 건수. 발송은 하지 않는다(편입 후 기존 가드된 발송 플로로 매니저가 안내).
 */
export async function importActiveCandidates(
  candidates: ReengagementCandidate[]
): Promise<number> {
  if (candidates.length === 0) return 0;
  const supabase = createServiceClient();

  // 경합/재실행 방지 — 최신 지원자 전화 재확인 후 신규만.
  const existing = await fetchApplicantPhones();
  const fresh = candidates.filter((c) => !existing.has(c.phone));
  if (fresh.length === 0) return 0;

  let imported = 0;
  const CHUNK = 200;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const rows = fresh.slice(i, i + CHUNK).map((c) => ({
      name: c.name ?? "(이름 미상)",
      phone: c.phone,
      source: "reengagement",
      status: "스크리닝 전",
    }));
    const { data, error } = await supabase.from("applicants").insert(rows).select("id");
    if (error) {
      console.error("[reengagement] import insert failed", error);
      throw new Error(error.message);
    }
    imported += data?.length ?? 0;
  }
  return imported;
}
