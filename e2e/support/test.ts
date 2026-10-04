// The journeys' `test`: Playwright's, with the console watched in every
// context a spec creates and checked at the end of every test.

import { test as base, expect, type Browser } from '@playwright/test'
import { drain, watch } from './console.ts'

export { expect }

export const test = base.extend<{ cleanConsole: void }, { browser: Browser }>({
  // Every context, the built-in one and those a spec opens for another
  // person, is watched from the moment it exists.
  browser: [async ({ browser }, use) => {
    const create = browser.newContext.bind(browser)
    browser.newContext = async (options) => {
      const context = await create(options)
      watch(context)
      return context
    }
    await use(browser)
  }, { scope: 'worker' }],

  cleanConsole: [async ({}, use) => {
    await use()
    expect(drain(), 'the browser console must stay clean').toEqual([])
  }, { auto: true }],
})
