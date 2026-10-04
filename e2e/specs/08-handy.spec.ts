// Am Handy: die Seiten sind in Handybreite benutzbar; die Bilder dafür
// gehören in die Anleitung.

import { devices } from '@playwright/test'
import { expect, test } from '../support/test.ts'
import { batchId, electionId } from '../support/journey.ts'
import { ANNA } from '../support/personas.ts'
import { shot } from '../support/screenshot.ts'
import { openAs } from '../support/sign-in.ts'

test('Anmeldung, Meine Wahlen, die Wahl und die Druckseite am Handy', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  const page = await context.newPage()
  await page.goto('/')
  await shot(page, '14-handy-anmeldung')
  await openAs(page, ANNA, '/')
  await expect(page.getByRole('heading', { name: 'Meine Wahlen' })).toBeVisible()
  await shot(page, '15-handy-meine-wahlen')
  await page.getByRole('link', { name: 'Schulsprecherwahl 2026/27' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Schulsprecherwahl 2026/27' })).toBeVisible()
  for (const name of ['Einrichten', 'Mitglieder', 'Vorbereiten', 'Stimmkarten']) {
    await expect(page.getByRole('region', { name })).toBeVisible()
  }
  await shot(page, '16-handy-wahl')
  await page.goto(`/elections/${electionId()}/batches/${batchId('1A regular')}/print`)
  await expect(page.getByTestId('card')).toHaveCount(25)
  await shot(page, '17-handy-druckseite')
  await context.close()
})
