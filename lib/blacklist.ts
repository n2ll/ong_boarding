import { createServiceClient } from "@/lib/supabase";
import { normalizePhone } from "@/lib/ongmanaging";

/**
 * 재채용 블랙리스트 — "절대 재채용 불가" 명단(recruitment_blacklist, 전화번호 정규화 키).
 * 서버 전용(service_role). 콜드 발송 하드 제외 + (Phase B) 신규 편입 제외에 쓴다.
 */

/** 블랙리스트 전화번호(정규화) 전체 집합 — 대량 발송 제외 대조용. */
export async function fetchBlacklistedPhones(): Promise<Set<string>> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.from("recruitment_blacklist").select("phone");
  if (error) {
    console.error("[blacklist] fetch failed", error);
    return new Set();
  }
  return new Set(
    (data ?? []).map((r) => normalizePhone(String((r as { phone: string | null }).phone ?? ""))).filter(Boolean)
  );
}

/** 단건 조회 — 이 전화번호가 블랙리스트인가. */
export async function isPhoneBlacklisted(phone: string): Promise<boolean> {
  const p = normalizePhone(phone);
  if (!p) return false;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("recruitment_blacklist")
    .select("id")
    .eq("phone", p)
    .maybeSingle();
  return Boolean(data);
}
