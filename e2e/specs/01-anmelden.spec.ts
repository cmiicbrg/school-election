// Anmelden und Abmelden: wer nicht angemeldet ist, landet auf der
// Anmeldeseite und kommt nach der Anmeldung dorthin, wo er hinwollte.

import { expect, test } from '../support/test.ts'
import { ANNA } from '../support/personas.ts'
import { shot } from '../support/screenshot.ts'
import { signInAs, signOut } from '../support/sign-in.ts'

test.describe.configure({ mode: 'serial' })

test('wer nicht angemeldet ist, landet auf der Anmeldeseite und kommt angemeldet zu Meine Wahlen', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/anmelden\?returnTo=(%2F|\/)$/)
  await shot(page, '01-anmeldung')
  await signInAs(page, ANNA)
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'Meine Wahlen' })).toBeVisible()
  await expect(page.getByText('Sie sind noch bei keiner Wahl Mitglied.')).toBeVisible()
  await shot(page, '02-meine-wahlen-leer')
  await signOut(page)
  await expect(page.getByRole('navigation', { name: 'Konto' })).toHaveCount(0)
})

test('ein Link in die App führt nach der Anmeldung dorthin', async ({ page }) => {
  await page.goto('/wahlen/neu')
  await expect(page).toHaveURL(/\/anmelden\?returnTo=(%2F|\/)wahlen(%2F|\/)neu$/)
  await signInAs(page, ANNA)
  await expect(page).toHaveURL(/\/wahlen\/neu$/)
  await expect(page.getByRole('heading', { name: 'Neue Wahl' })).toBeVisible()
})
