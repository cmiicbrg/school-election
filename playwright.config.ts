// The browser journeys (e2e/specs): one worker, the specs of a file in
// order and each building on the one before, against the real server
// that e2e/harness/server.ts starts with a fresh database and the sign-in
// stand-in. Chromium at desktop size; a journey that needs a phone opens
// its own context. The VS Code Playwright extension finds this file at the
// repository's root.

import { defineConfig, devices } from '@playwright/test'
import { BASE_PATH } from './e2e/support/base.ts'

const PORT = Number(process.env.E2E_PORT ?? 3100)
// The app's address with its base path and a trailing slash, so that the
// relative paths the specs navigate to (e2e/support/base.ts) resolve under it.
const baseURL = `http://127.0.0.1:${PORT}${BASE_PATH}/`
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
  // Never a server that is already there: the journeys need the fresh
  // database the harness creates, and whatever answers on the port before
  // the run is a harness left behind or another process altogether. A
  // busy port fails the run instead. At the end the harness gets SIGTERM,
  // not the default SIGKILL, so that it drops its database.
  webServer: {
    command: 'npm run build && node e2e/harness/server.ts',
    url: `${baseURL}api/health`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
