"use client";

/**
 * 루트 레이아웃 자체가 죽었을 때의 최후 방어선 — app/error.tsx는 레이아웃 오류를 못 잡는다.
 * 이 컴포넌트는 html/body를 스스로 그려야 한다(Next 규약). 스타일 시스템도 죽었을 수 있어
 * 인라인 스타일만 쓴다.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  console.error("[global error boundary]", error);
  return (
    <html lang="ko">
      <body style={{ margin: 0, fontFamily: "-apple-system, sans-serif", background: "#F4F2EC", color: "#111827" }}>
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 40 }} aria-hidden>⚠️</div>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>화면을 불러오지 못했어요</h1>
          <p style={{ maxWidth: 420, fontSize: 14, lineHeight: 1.6, color: "#5D6470", margin: 0 }}>
            일시적인 오류일 수 있어요. 다시 시도해 주세요.
            {error.digest ? ` (오류 코드: ${error.digest})` : ""}
          </p>
          <button
            onClick={reset}
            style={{ minHeight: 44, borderRadius: 12, background: "#111827", color: "#fff", border: 0, padding: "0 20px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
          >
            다시 시도
          </button>
        </div>
      </body>
    </html>
  );
}
