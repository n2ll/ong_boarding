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

/** 지원자/카드의 지점 문자열이 선택된 스코프에 속하는지 (느슨한 매칭). */
export function matchesBranchScope(branchValue: string | null | undefined, scope: string | null): boolean {
  if (!scope) return true;
  if (!branchValue) return false;
  const a = branchValue.trim();
  return a === scope || a.includes(scope) || scope.includes(a);
}
