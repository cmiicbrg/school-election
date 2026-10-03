// The browser journeys (e2e/specs): one worker, the specs of a file in
// order and each building on the one before, against the real server
// that e2e/harness/server.ts starts with a fresh database and the sign-in
// stand-in. Chromium at desktop size; a journey that needs a phone opens
// its own context. The VS Code Playwright extension finds this file at the
// repository's root.

import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 3100)
const baseURL = `http://127.0.0.1:${PORT}`
const ci = process.env.CI === 'true'

export default defineConfig({
  testDir: 'e2e/specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: ci,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    locale: 'de-AT',
    timezoneId: 'Europe/Vienna',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'npm run build && node e2e/harness/server.ts',
    url: `${baseURL}/api/health`,
    reuseExistingServer: !ci,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
