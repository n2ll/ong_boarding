import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
const port = 3187;
export default defineConfig({
  ...base,
  testMatch: "pool-pilot.spec.ts",
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    ...(base.webServer as object),
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    env: { ...((base.webServer as { env?: Record<string, string> }).env ?? {}), CLAUDE_API: "" },
  },
});
