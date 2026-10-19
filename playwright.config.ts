import { defineConfig } from "@playwright/test";

/**
 * Two targets:
 *  - default: the single-container server (background timer on, embedded Postgres)
 *  - E2E_TARGET=vercel: the built .vercel/output served with Vercel's routing, a real Postgres
 *    (E2E_DATABASE_URL) and no background timer — requests alone drive the plant, as on Vercel.
 */
const vercel = process.env.E2E_TARGET === "vercel";
const PORT = vercel ? 8095 : 8099;
const command = vercel
  ? `DATABASE_URL=${process.env.E2E_DATABASE_URL} VERCEL=1 VERCEL_ENV=rehearsal TICK_MS=150 PORT=${PORT} node scripts/vercel-local.mjs`
  : `pnpm --filter @ordo/web build && cd server && DATA_DIR=memory TICK_MS=150 WEB_DIST=../web/dist PORT=${PORT} npx tsx src/index.ts`;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
    trace: "retain-on-failure",
  },
  webServer: { command, url: `http://localhost:${PORT}/health`, timeout: 120_000, reuseExistingServer: false },
});
