"use client";

/**
 * 전역 지점 스코프.
 *
 * 헤더의 지점 필터에서 선택한 지점을 앱 전역에서 공유한다.
 * null = '전체 지점'. 선택은 localStorage에 저장돼 새로고침에도 유지된다.
 *
 * 소비처: 대시보드 통계, 파이프라인 목록 등 '전체 보기' 성격의 화면.
 * (각 화면이 useBranchScope().branch 로 읽어 자체 필터에 반영)
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const STORAGE_KEY = "ong:branchScope";

interface BranchScopeValue {
  branch: string | null;
  setBranch: (b: string | null) => void;
}

const BranchScopeContext = createContext<BranchScopeValue>({
  branch: null,
  setBranch: () => {},
});

export function BranchScopeProvider({ children }: { children: ReactNode }) {
  const [branch, setBranchState] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setBranchState(saved);
    } catch {
      /* localStorage 접근 불가 환경 무시 */
    }
  }, []);

  const setBranch = (b: string | null) => {
    setBranchState(b);
    try {
      if (b) localStorage.setItem(STORAGE_KEY, b);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 무시 */
    }
  };

  return (
    <BranchScopeContext.Provider value={{ branch, setBranch }}>
      {children}
    </BranchScopeContext.Provider>
  );
}

export function useBranchScope(): BranchScopeValue {
  return useContext(BranchScopeContext);
}

// 지점 값이 사실상 '없음'인 자리표시값 — 도시락 등 지점 개념이 없는 라인이 여기 해당.
const BRANCHLESS_PLACEHOLDERS = new Set(["", "-", "미지정", "미확인"]);

/** 지원자/카드의 지점 문자열이 선택된 스코프에 속하는지 (느슨한 매칭).
 *  ⚠️ 지점이 없는 라인(도시락 등, branch=null/'미지정'/'-')은 지점 스코프와 무관하게 **항상 통과**시킨다.
 *  (예전엔 false로 걸러 매니저가 지점을 고르는 순간 도시락 지원자가 목록·지도·지표에서 소리 없이 전멸했음.
 *   지점은 배민식 조직 축이라 지점 없는 라인은 그 축에 속하지 않을 뿐, 숨길 대상이 아니다.) */
export function matchesBranchScope(branchValue: string | null | undefined, scope: string | null): boolean {
  if (!scope) return true;
  const a = (branchValue ?? "").trim();
  if (BRANCHLESS_PLACEHOLDERS.has(a)) return true; // 지점 없는 라인 — 스코프 무관 항상 노출
  return a === scope || a.includes(scope) || scope.includes(a);
}
