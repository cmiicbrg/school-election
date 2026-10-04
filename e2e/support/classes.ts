// Which contests a class votes in, ticked as a teacher ticks them. The
// page changes the box at once and sends the whole mapping behind it, so
// a step that builds on the mapping (preparing, reading it back) waits
// for that request, not for the box.

import { expect, type Page } from '@playwright/test'

const SAVE = /\/api\/elections\/[0-9a-f-]{36}\/voter-groups\/[0-9a-f-]{36}\/contests$/

/** Ticks `contest` for the class `group` and waits until the page has saved the mapping. */
export async function assignContest(page: Page, group: string, contest: string): Promise<void> {
  const box = page.getByRole('article', { name: group, exact: true }).getByRole('checkbox', { name: contest })
  const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && SAVE.test(response.url()))
  await box.check()
  expect((await saved).ok()).toBe(true)
  await expect(box).toBeChecked()
}
