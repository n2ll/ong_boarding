import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const baseURL = "http://127.0.0.1:3178";
const server = base.webServer as NonNullable<Exclude<typeof base.webServer, unknown[]>>;

export default defineConfig({
  ...base,
  testMatch: ["multi-job-consultation.spec.ts", "admin-status-accuracy.spec.ts"],
  testIgnore: [],
  use: { ...base.use, baseURL },
  webServer: [
    { command: "node e2e/fixtures/consultation-auth.mjs", url: "http://127.0.0.1:3179/health", reuseExistingServer: false },
    // dev의 폰트 manifest 재작성 경합을 피하고 배포와 같은 빌드로 관리자 화면을 검수한다.
    { ...server, command: "npm run build && npm run start -- --hostname 127.0.0.1 --port 3178", url: `${baseURL}/login`,
      env: { ...server.env, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:3179",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "consultation-fixture", ADMIN_ALLOWED_EMAILS: "consultation@example.test" } },
  ],
});
