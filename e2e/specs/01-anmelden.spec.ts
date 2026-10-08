// Anmelden und Abmelden: wer nicht angemeldet ist, landet auf der
// Anmeldeseite und kommt nach der Anmeldung dorthin, wo er hinwollte.

import { expect, test } from '../support/test.ts'
import { refused } from '../support/console.ts'
import { ANNA } from '../support/personas.ts'
import { shot } from '../support/screenshot.ts'
import { at, encodedPath, urlOf } from '../support/base.ts'
import { openAs, signInAs, signOut } from '../support/sign-in.ts'

test.describe.configure({ mode: 'serial' })

test('wer nicht angemeldet ist, landet auf der Anmeldeseite und kommt angemeldet zu Meine Wahlen', async ({ page }) => {
  await page.goto(at('/'))
  await expect(page).toHaveURL(new RegExp(`/anmelden\\?returnTo=${encodedPath('/')}$`))
  await shot(page, '01-anmeldung')
  await signInAs(page, ANNA)
  await expect(page).toHaveURL(urlOf('/'))
  await expect(page.getByRole('heading', { name: 'Meine Wahltermine' })).toBeVisible()
  await expect(page).toHaveTitle('Meine Wahltermine – Schulwahl')
  await expect(page.getByText('Sie sind noch bei keinem Wahltermin Mitglied.')).toBeVisible()
  await shot(page, '02-meine-wahlen-leer')
  await signOut(page)
  await expect(page.getByRole('navigation', { name: 'Konto' })).toHaveCount(0)
})

test('ein Link in die App führt nach der Anmeldung dorthin', async ({ page }) => {
  await page.goto(at('/wahlen/neu'))
  await expect(page).toHaveURL(new RegExp(`/anmelden\\?returnTo=${encodedPath('/wahlen/neu')}$`))
  await signInAs(page, ANNA)
  await expect(page).toHaveURL(/\/wahlen\/neu$/)
  await expect(page.getByRole('heading', { name: 'Neue Wahl' })).toBeVisible()
})

test('eine abgelaufene Sitzung führt zur Anmeldeseite und nach der Anmeldung zurück', async ({ page }) => {
  await openAs(page, ANNA, '/wahlen/neu')
  await page.context().clearCookies()
  await page.getByLabel('Titel des Wahltermins').fill('Probewahl')
  await refused(page, 401, () => page.getByRole('button', { name: 'Wahltermin anlegen' }).click())
  await expect(page).toHaveURL(new RegExp(`/anmelden\\?returnTo=${encodedPath('/wahlen/neu')}$`))
  await signInAs(page, ANNA)
  await expect(page).toHaveURL(/\/wahlen\/neu$/)
  await expect(page.getByRole('heading', { name: 'Neue Wahl' })).toBeVisible()
})
