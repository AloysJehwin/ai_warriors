import { defineConfig } from "@playwright/test";

const PORT = 8099;
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm --filter @ordo/web build && cd server && DATA_DIR=memory TICK_MS=150 WEB_DIST=../web/dist PORT=${PORT} npx tsx src/index.ts`,
    url: `http://localhost:${PORT}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
