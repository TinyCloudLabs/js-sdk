import { defineConfig, devices } from "@playwright/test";

// Browser smoke tests for the UI module. Run with `bun run test:e2e`.
// Specs live in e2e/ and end in .pw.ts so bun test and jest do not pick them up.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  outputDir: "e2e/.build/test-results",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    actionTimeout: 5000,
    trace: "on-first-retry",
  },
  timeout: 30000,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
