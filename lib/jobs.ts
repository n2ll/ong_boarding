/**
 * 공고 상태 공용 헬퍼.
 *
 * 마감시각(closes_at)이 지난 공고는 status가 'active'로 남아 있어도 실질적으로 마감이다.
 * status와 closes_at을 각자 해석하면 목록 배지·AI 배지·통계·dispatch·interest 가드가 서로
 * 모순된다("진행 중" 배지 + "마감됨" 텍스트, 마감 공고에 발송 허용 등). 이 단일 판단으로 통일한다.
 *
 * ⚠️ pull(/p/[token])은 마감 후 3일 유예 카드 로직을 따로 두므로 여기서 판단하지 않는다.
 * (크론 자동 status 승격은 범위 밖 — 이 헬퍼는 표시/동작 일관성만 담당한다.)
 */

/** status가 active가 아니거나, closes_at이 과거면 실질 마감으로 본다. */
export function isJobEffectivelyClosed(
  status: string | null | undefined,
  closesAt: string | null | undefined
): boolean {
  if (status !== "active") return true;
  if (closesAt && new Date(closesAt).getTime() <= Date.now()) return true;
  return false;
}

/**
 * 시스템 예약 프리픽스.
 *
 * `__danggeun_system__`·`__baemin_system__` 등 인입 라우터가 쓰는 더미 공고는 제목이 `__`로 시작한다.
 * 이 프리픽스로 시작하는 공고는 매니저 목록·pull(/p/[token])·검색에서 숨겨진다. 판정이 클라·서버·pull에
 * 제각각(startsWith·neq·like)이면 "등록됐는데 목록에서 사라지는" 혼란이 생기므로 이 헬퍼로 단일화한다.
 */
export const SYSTEM_JOB_TITLE_PREFIX = "__";

/** 제목이 시스템 예약 프리픽스(`__`)로 시작하면 시스템 공고로 본다(목록·pull·검색에서 숨김 대상). */
export function isSystemJobTitle(title: string | null | undefined): boolean {
  return typeof title === "string" && title.startsWith(SYSTEM_JOB_TITLE_PREFIX);
}

/** 사용자 입력 제목에서 앞쪽 `__`(및 연속된 언더스코어)를 제거한다 — 사용자가 실수로 넣은 예약 프리픽스 방어용. */
export function stripSystemPrefix(title: string): string {
  return title.replace(/^_+/, "");
}

/**
 * DB 제약 위반(23514 check / 22001 길이 초과)을 매니저가 읽을 수 있는 문장으로 바꾼다.
 *
 * 왜: 등록·수정 실패가 "공고 등록에 실패했어요" 한 줄로만 떠서, 어느 칸이 문제인지 알 수 없었다.
 * 실제로 근무시간에 '평일 오전'을 넣으면 `chk_jobs_slot` 위반으로 500이 났는데(제약은 4-슬롯만
 * 허용했다) 화면에는 아무 단서도 없었다 — 제약은 완화했지만, 다음 제약에서 같은 침묵이 반복되지
 * 않게 사유를 이름으로 돌려준다. 매칭되지 않으면 null(호출부가 기존 문구 유지).
 */
export function describeDbConstraintError(err: { code?: string; message?: string } | null | undefined): string | null {
  if (!err) return null;
  const code = err.code ?? "";
  const msg = err.message ?? "";
  if (code !== "23514" && code !== "22001") return null;
  const named: Record<string, string> = {
    chk_jobs_slot: "근무시간이 너무 길어요(80자까지). 짧게 줄여 주세요.",
    chk_jobs_capacity: "모집 인원 값이 올바르지 않아요.",
    chk_jobs_exposure: "노출 방식 값이 올바르지 않아요 — 전체 노출/지정 노출 중에서 고르세요.",
    chk_jobs_distance_basis: "거리 기준 값이 올바르지 않아요 — 집결지/가까운 쪽 중에서 고르세요.",
  };
  for (const [key, text] of Object.entries(named)) {
    if (msg.includes(key)) return text;
  }
  if (code === "22001") return "입력한 값이 저장 가능한 길이를 넘었어요 — 짧게 줄여 주세요.";
  return "입력한 값 중 하나가 저장 규칙에 맞지 않아요 — 근무시간·인원·노출 설정을 확인해 주세요.";
}

/** 시간대 매칭용 4슬롯 어휘 — `jobs.slot_keys`의 유일한 값 집합(노출 규칙·조건 바와 같은 어휘). */
export const JOB_SLOT_KEYS = ["평일오전", "평일오후", "주말오전", "주말오후"] as const;

/**
 * `slot_keys` 입력 정규화 — 4슬롯 어휘만 남기고 중복·순서를 고정한다.
 * 반환: 정규화된 배열(빈 배열이면 null=미지정) / 어휘 밖 값이 섞였으면 **null이 아닌 undefined 대신
 * `null`을 돌려주지 않고** 호출부가 400을 낼 수 있게 `null`을 '거부' 신호로 쓴다(아래 규약).
 *
 * 규약: 입력이 배열이 아니면 `undefined`(=건드리지 않음), 어휘 밖 값이 있으면 `null`(=거부),
 * 정상이면 정규화 배열(빈 배열은 `[]`로 저장 — '미지정'을 명시적으로 비우는 동작).
 */
export function normalizeSlotKeys(input: unknown): string[] | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return [];
  if (!Array.isArray(input)) return null;
  const allowed = new Set<string>(JOB_SLOT_KEYS);
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!allowed.has(t)) return null;
    if (!out.includes(t)) out.push(t);
  }
  // 화면 순서(평일오전→평일오후→주말오전→주말오후)로 고정 — 표시·복제에서 순서가 흔들리지 않게.
  return JOB_SLOT_KEYS.filter((k) => out.includes(k));
}

/** 칩 값 → 사람이 읽는 라벨('평일오전' → '평일 오전'). 상세 시간이 비었을 때 표시·AI 안내에 쓴다. */
export function slotKeysLabel(keys: string[] | null | undefined): string {
  const list = (keys ?? []).filter((k) => (JOB_SLOT_KEYS as readonly string[]).includes(k));
  if (list.length === 0) return "";
  return JOB_SLOT_KEYS.filter((k) => list.includes(k))
    .map((k) => `${k.slice(0, 2)} ${k.slice(2)}`)
    .join(", ");
}

/**
 * 급여 한 줄 — `pay_info` 원문이 있으면 그것, 없으면 `pay_type`+`pay_amount` 조합. 둘 다 없으면 "".
 * 지원자에게 나가는 문구(관심 컨택 문자)와 에이전트 프롬프트(cross-job 블록)가 **같은 공식**을 써야 한다 —
 * 두 곳에서 다르게 조립하면 같은 공고의 급여가 문자와 AI 안내에서 다르게 보인다.
 */
export function jobPayLabel(j: {
  pay_info?: string | null;
  pay_type?: string | null;
  pay_amount?: number | null;
}): string {
  const info = (j.pay_info ?? "").trim();
  if (info) return info;
  if (typeof j.pay_amount === "number" && j.pay_amount > 0) {
    return `${j.pay_type ?? "급여"} ${j.pay_amount.toLocaleString("ko-KR")}원`;
  }
  return "";
}
