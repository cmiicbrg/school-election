// The browser's console stays clean: whatever a page logs at warning or
// error level, and whatever throws uncaught in it, fails the test it
// happened in. A refusal the test provokes on purpose is declared by the
// test, so the browser's one line about that response does not count.

import type { BrowserContext, Page } from '@playwright/test'

export interface Logged {
  /** What the browser reported, with its level. */
  text: string
  /** The resource or script it was about. */
  url: string
}

let logged: Logged[] = []
let expected: string[] = []

/** Collects from every page of `context`, popups included. */
export function watch(context: BrowserContext): void {
  context.on('console', (message) => {
    const type = message.type()
    if (type !== 'error' && type !== 'warning') return
    logged.push({ text: `${type}: ${message.text()}`, url: message.location().url })
  })
  context.on('weberror', (error) => {
    logged.push({ text: `uncaught: ${error.error().message}`, url: error.page()?.url() ?? '' })
  })
}

/** The browser's line about a failed response from `url` is expected once. */
export function expectFailure(url: string): void {
  expected.push(url)
}

/** Runs `action`, which makes the page send a request the API refuses with `status`, and expects the browser's line about it. */
export async function refused(page: Page, status: number, action: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((candidate) => candidate.url().includes('/api/') && candidate.status() === status)
  await action()
  expectFailure((await response).url())
}

/** What was logged and not declared since the last call; resets both. */
export function drain(): Logged[] {
  const unexpected: Logged[] = []
  for (const entry of logged) {
    const index = expected.indexOf(entry.url)
    if (index >= 0) expected.splice(index, 1)
    else unexpected.push(entry)
  }
  logged = []
  expected = []
  return unexpected
}
