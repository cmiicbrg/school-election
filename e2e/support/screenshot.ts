// Full-page screenshots of the journeys' steps, named in order, for a quick
// look at the app without clicking through it. Only when SCREENSHOT_DIR is
// set (npm run e2e:screenshots, into a folder git ignores); a normal run
// writes none.

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'

// Toasts sit at the bottom of the window; in a picture of the whole page
// they would land over whatever is at that height, so the picture leaves
// them out, only while it is taken. Through the element's style object:
// the app's Content-Security-Policy refuses an injected stylesheet.
async function toastsShown(page: Page, shown: boolean): Promise<void> {
  await page.locator('.toasts').evaluateAll((regions, visibility) => {
    for (const region of regions) (region as HTMLElement).style.visibility = visibility
  }, shown ? '' : 'hidden')
}

export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SCREENSHOT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await toastsShown(page, false)
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true })
  await toastsShown(page, true)
}
