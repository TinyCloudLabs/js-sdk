import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for TinyCloud web-sdk-example E2E tests.
 *
 * Environment variables:
 * - TINYCLOUD_HOST: TinyCloud server URL (default: http://localhost:8000)
 * - CI: Set to true in CI environments for stricter settings
 */
export default defineConfig({
  testDir: './e2e/tests',

  // Run tests sequentially - auth state matters between tests
  fullyParallel: false,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Single worker for sequential execution
  workers: 1,

  // Reporter to use
  reporter: process.env.CI ? 'github' : 'html',

  // Shared settings for all projects
  use: {
    // Base URL for the app
    baseURL: 'http://localhost:3000',

    // Collect trace when retrying the failed test
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'on-first-retry',

    // Timeout for actions
    actionTimeout: 10000,

    // Timeout for navigation
    navigationTimeout: 30000,
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Run your local dev server before starting the tests
  webServer: {
    // FAST_REFRESH=false is REQUIRED, not a preference. packages/web-sdk/dist is a
    // pre-bundled webpack output, and CRA's React Fast Refresh injects
    // `<nested_webpack_require>.$Refresh$.runtime = ...` into it. That nested
    // runtime has no `$Refresh$`, so importing the SDK throws
    // "Cannot set properties of undefined (setting 'runtime')" and the app renders
    // a blank page -- which made every e2e test time out waiting for the UI.
    // Dev-server only; production builds do not run Fast Refresh.
    command: 'FAST_REFRESH=false npm start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },

  // Global timeout for each test
  timeout: 60000,

  // Expect timeout
  expect: {
    timeout: 10000,
  },
});
