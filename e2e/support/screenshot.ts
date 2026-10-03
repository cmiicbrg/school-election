// Screenshots for the teacher's guide, taken at the steps the guide shows
// and named in order. Only when SCREENSHOT_DIR is set (npm run
// e2e:screenshots); a normal run writes none.

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'

export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SCREENSHOT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true })
}
