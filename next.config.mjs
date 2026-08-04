/** @type {import('next').NextConfig} */
const nextConfig = {
  // lint를 build 게이트로 쓴다 — .eslintrc.cjs는 훅 순서(react-hooks/rules-of-hooks)만 error로 본다.
  // 예전엔 ignoreDuringBuilds: true라 규칙이 한 번도 돌지 않았고, 조기 return 뒤에 선언된 useState
  // 하나가 1주일간 지원자 상세 화면을 죽였다(React #310). 스타일 규칙을 늘려 이 게이트를 소음으로
  // 만들지 말 것 — 늘리는 순간 빌드 실패가 일상이 되고 다시 끄게 된다.
  eslint: { dirs: ["app", "components", "lib"] },
};

export default nextConfig;
