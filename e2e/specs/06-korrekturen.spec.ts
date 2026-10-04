// Korrekturen nach dem Vorbereiten: eine Änderung am Aufbau macht die
// Stimmkarten einer Klasse ungültig, und die Seite fragt, bevor sie es
// tut.

import type { Page } from '@playwright/test'
import { expect, test } from '../support/test.ts'
import { assignContest } from '../support/classes.ts'
import { refused } from '../support/console.ts'
import { electionId } from '../support/journey.ts'
import { ANNA } from '../support/personas.ts'
import { shot } from '../support/screenshot.ts'
import { openAs } from '../support/sign-in.ts'

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage()
  await openAs(page, ANNA, `/wahlen/${electionId()}`)
})

test.afterAll(async () => {
  await page.context().close()
})

test('die 2B wählt nun auch die Klassensprecher:in: ihre Stimmkarten passen nicht mehr', async () => {
  await page.getByRole('button', { name: 'Zurück zum Entwurf' }).click()
  await expect(page.getByText(/^Entwurf · Ihre Rolle/)).toBeVisible()
  await assignContest(page, '2B', 'Klassensprecher/in 1A')

  // Preparing is refused until the voiding is confirmed: that refusal is the dialog.
  await refused(page, 409, () => page.getByRole('button', { name: 'Vorbereiten', exact: true }).click())
  const dialog = page.getByRole('alertdialog', { name: 'Stimmkarten werden ungültig' })
  await expect(dialog).toContainText('2B: 20 Stimmkarten')
  await expect(page.getByText(/^Entwurf · Ihre Rolle/)).toBeVisible()
  await shot(page, '13-stimmkarten-werden-ungueltig')
  await dialog.getByRole('button', { name: 'Abbrechen' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText(/^Entwurf · Ihre Rolle/)).toBeVisible()

  await refused(page, 409, () => page.getByRole('button', { name: 'Vorbereiten', exact: true }).click())
  await page.getByRole('alertdialog', { name: 'Stimmkarten werden ungültig' }).getByRole('button', { name: 'Trotzdem vorbereiten (20 Stimmkarten werden ungültig)' }).click()
  await expect(page.getByText(/^Vorbereitet · Ihre Rolle/)).toBeVisible()
  const sheets = page.getByRole('region', { name: 'Stimmkarten' })
  const box2B = sheets.locator('.card-box').filter({ has: page.getByRole('heading', { name: '2B', exact: true }) })
  await expect(box2B.getByTestId('batch-regular-void')).toContainText('ungültig')
  await expect(box2B.getByTestId('batch-regular-issued')).toHaveCount(0)
})
