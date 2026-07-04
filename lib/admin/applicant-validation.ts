/**
 * applicants 필드 검증 상수 — 단건 PATCH(applicants/[id])와 벌크(bulk-status)가 공유.
 * route.ts는 핸들러 외 export가 금지되므로 여기서 관리한다.
 */

export const VALID_STATUS = new Set([
  "스크리닝 전",
  "스크리닝 중",
  "스크리닝 완료",
  "기타",
  "확정인력",
  "대기자",
  "부적합",
  "이탈",
]);

export const VALID_SLOT = new Set(["평일오전", "평일오후", "주말오전", "주말오후"]);

// 온보딩 통화 상태 — UI(ApplicantDetailPanel) select 옵션과 동일 집합.
// TEXT 자유입력 시절 쌓인 쓰레기값('o', 'o 10:00', '전화완료' 등) 재유입 방지.
// null/빈값(미지정)은 허용.
export const VALID_CALL_STATUS = new Set([
  "미실시",
  "통화 완료",
  "부재중",
  "예정",
  "카톡대체",
]);

// 가용성 축 (Phase B) — status(채용 단계)와 별개. null(미확인)은 허용.
export const VALID_AVAILABILITY = new Set(["즉시가능", "이번주가능", "휴면"]);

// 콤마로 구분된 confirmed_slot 값 검증 — 각 토큰이 VALID_SLOT에 포함돼야 함.
export function isValidConfirmedSlot(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const tokens = v.split(",").map((t) => t.trim()).filter(Boolean);
  return tokens.every((t) => VALID_SLOT.has(t));
}
