import { defineConfig } from "@playwright/test";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // Realtime이 있는 관리자 상담 화면은 로컬 인증 fixture를 갖춘 전용 설정으로 실행한다.
  testIgnore: "multi-job-consultation.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      ANTHROPIC_API_KEY: "",
      SOLAPI_API_KEY: "",
      SOLAPI_API_SECRET: "",
      SOLAPI_SENDER: "",
      SLACK_NOTIFICATIONS_ENABLED: "0",
      SLACK_WEBHOOK_URL: "",
      SMS_DRY_RUN: "true",
      VERCEL_ENV: "preview",
    },
  },
});
