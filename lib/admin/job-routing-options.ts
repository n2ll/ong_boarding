export interface JobRoutingOption {
  id: number;
  active?: boolean;
}

/** 신규 등록에서는 서버가 받을 수 있는 활성 선택지만 보여준다. */
export function newJobRoutingOptions<T extends JobRoutingOption>(options: readonly T[]): T[] {
  return options.filter((option) => option.active !== false);
}

/** 수정에서는 현재 연결값만 예외로 남겨 오래된 공고를 편집 불가 상태로 만들지 않는다. */
export function editJobRoutingOptions<T extends JobRoutingOption>(
  options: readonly T[],
  currentId: number | "",
): T[] {
  return options.filter((option) => option.active !== false || option.id === currentId);
}
