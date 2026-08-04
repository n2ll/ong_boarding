// 훅 순서 규칙을 build에서 강제하려고 최소 구성으로 둔다.
// 스타일·취향 규칙은 넣지 않는다 — 경고가 쌓이면 아무도 빌드 로그를 안 읽고,
// 그 순간 이 게이트는 없는 것과 같아진다. 여기 있는 규칙은 '화면이 죽는 것'만 막는다.
// (package.json이 "type":"module"이라 .cjs 확장자를 쓴다.)
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  plugins: ["react-hooks", "@next/next"],
  extends: ["plugin:@next/next/recommended"],
  rules: {
    // 조기 return 뒤에 훅을 선언하면, 데이터가 도착한 렌더에서 훅 개수가 달라져 React가 화면을
    // 통째로 날린다(#310). 2026-07-29~08-05 지원자 상세가 실제로 이 사고로 죽어 있었다 — 그래서 error.
    "react-hooks/rules-of-hooks": "error",
    // exhaustive-deps는 끈다. 이 레포는 의존성을 의도적으로 뺀 effect(폴링·1회성 로드·ref 우회)가
    // 많아 경고가 수십 개 쌓이고, 그 소음이 위 error를 묻는다. 훅 순서만 막는 게 목적이다.
    "react-hooks/exhaustive-deps": "off",

    // ── 배포를 막을 수 있는 규칙은 위의 rules-of-hooks '하나'로 유지한다 ──
    // @next/next/recommended에는 error 등급이 8개 딸려 오는데, 대부분 Pages Router 전용이고
    // (이 레포는 App Router) no-html-link-for-pages는 오탐으로 유명하다. 정보는 남기되(warn)
    // 배포를 세우지는 못하게 내린다 — 무관한 규칙으로 급한 배포가 막히면 이 게이트를 통째로
    // 끄게 되고, 그러면 훅 순서도 다시 못 잡는다.
    "@next/next/inline-script-id": "warn",
    "@next/next/no-assign-module-variable": "warn",
    "@next/next/no-document-import-in-page": "warn",
    "@next/next/no-duplicate-head": "warn",
    "@next/next/no-head-import-in-document": "warn",
    "@next/next/no-html-link-for-pages": "warn",
    "@next/next/no-script-component-in-head": "warn",
    "@next/next/no-sync-scripts": "warn",
  },
  ignorePatterns: [".next/", "node_modules/", "next-env.d.ts"],
};
