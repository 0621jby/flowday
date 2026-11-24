import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3110",
    channel: "chrome",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3110",
    url: "http://127.0.0.1:3110/api/health",
    reuseExistingServer: false,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
      APP_ORIGIN: "http://127.0.0.1:3110",
      FLOWDAY_ALLOW_LOCAL_HTTP: "1",
      AI_PROVIDER: "mock",
      AI_ENABLE_PAID_CALLS: "false",
    },
  },
});
