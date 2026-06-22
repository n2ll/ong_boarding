"use client";

import { useEffect, useRef, useState } from "react";

/*
  점진 렌더링 훅 — 큰 리스트를 한 번에 다 그리지 않고 step개씩 늘려 그린다.
  react-window 같은 고정 높이 가상화 대신, 가변 높이 카드/기존 스크롤 컨테이너와
  충돌 없이 DOM 노드 수만 제어한다. 끝에 둔 sentinel이 화면에 들어오면 count를 늘린다.

  resetKey가 바뀌면(검색어/필터 변경 등) 처음으로 되감는다.
  Realtime 갱신으로 items 참조만 바뀌는 경우엔 스크롤 위치를 유지하려고 리셋하지 않는다.
*/
export function useIncrementalList<T>(
  items: T[],
  opts?: { step?: number; resetKey?: unknown }
) {
  const step = opts?.step ?? 40;
  const resetKey = opts?.resetKey;
  const [count, setCount] = useState(step);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCount(step);
  }, [resetKey, step]);

  const hasMore = count < items.length;

  useEffect(() => {
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setCount((c) => c + step);
      },
      { rootMargin: "300px" }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [hasMore, step]);

  return { visible: items.slice(0, count), hasMore, sentinelRef };
}
