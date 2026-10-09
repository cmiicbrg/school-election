// Am Handy: die Seiten sind in Handybreite benutzbar; die Bilder dafür
// gehören in die Anleitung.

import { devices } from '@playwright/test'
import { expect, test } from '../support/test.ts'
import { batchId, electionId } from '../support/journey.ts'
import { ANNA } from '../support/personas.ts'
import { shot } from '../support/screenshot.ts'
import { at, urlOf } from '../support/base.ts'
import { signInAs } from '../support/sign-in.ts'

test('Anmeldung, Meine Wahlen, die Wahl und die Druckseite am Handy', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  const page = await context.newPage()
  await page.goto(at('/'))
  await expect(page.getByRole('heading', { name: 'Anmeldung', exact: true })).toBeVisible()
  await shot(page, '14-handy-anmeldung')
  await signInAs(page, ANNA)
  await expect(page).toHaveURL(urlOf('/'))
  await expect(page.getByRole('heading', { name: 'Meine Wahltermine' })).toBeVisible()
  await shot(page, '15-handy-meine-wahlen')
  await page.getByRole('link', { name: 'Schulsprecherwahl 2026/27' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Schulsprecherwahl 2026/27' })).toBeVisible()
  for (const name of ['Einrichten', 'Mitglieder', 'Vorbereiten', 'Stimmkarten']) {
    await expect(page.getByRole('region', { name })).toBeVisible()
  }
  // On a phone the steps are a strip under the title that names the current one and opens the list.
  const steps = page.getByRole('navigation', { name: 'Schritte' })
  await expect(steps).toHaveCount(0)
  await page.getByText('Schritt 4 von 7').click()
  await expect(steps.locator('[aria-current="step"]')).toContainText('Stimmkarten')
  await steps.getByRole('link', { name: 'Probelauf' }).click()
  await expect(page.getByRole('heading', { name: 'Probelauf' })).toBeFocused()
  await expect(steps).toHaveCount(0)
  // Nothing is wider than the phone: a table scrolls in its box, and buttons are a finger's size.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  expect((await page.getByRole('button', { name: 'Aufklappen' }).first().boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await shot(page, '16-handy-wahl')
  await page.goto(at(`/elections/${electionId()}/batches/${batchId('1A regular')}/print`))
  await expect(page.getByTestId('card')).toHaveCount(25)
  await shot(page, '17-handy-druckseite')
  await context.close()
})
