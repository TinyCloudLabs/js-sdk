import { defineConfig, devices } from '@playwright/test';

/**
 * Minimal Playwright config for standalone SDK API browser tests.
 *
 * Serves test-page.html via a simple static file server.
 * Does NOT require the example app's dev server.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',

  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,

  reporter: process.env.CI ? 'github' : 'html',

  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 30000,
    navigationTimeout: 30000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Serve the test page and SDK bundle from this directory
  webServer: [
    {
      command: 'python3 -m http.server 4173',
      url: 'http://localhost:4173/test-page.html',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: 'bun ./credential-journey-driver.ts',
      url: 'http://127.0.0.1:4175/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],

  timeout: 120000,

  expect: {
    timeout: 30000,
  },
});
