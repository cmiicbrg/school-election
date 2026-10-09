// Vorbereiten: die Zusammenfassung, der Schritt, was danach noch geht
// (Namen), und der Weg zurück zum Entwurf; und eine Seite, die beim
// Neuladen die Verbindung verliert, behält den letzten Stand.

import type { Page } from '@playwright/test'
import { expect, test } from '../support/test.ts'
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

test('die Zusammenfassung zeigt, wer wo wählt, und weist auf die fehlende zweite Zeugin hin', async () => {
  const prepare = page.getByRole('region', { name: 'Vorbereiten' })
  await expect(prepare.getByRole('table').first()).toContainText('1A')
  await expect(prepare.getByRole('table').first()).toContainText('Klassensprecher/in 1A, Schulsprecher/in')
  await expect(prepare.getByRole('table').nth(1)).toContainText('Schulsprecher/in')
  await expect(prepare.getByRole('list', { name: 'Empfohlen' })).toContainText('Zwei Zeug:innen haben sich angemeldet: offen')
  await expect(prepare.getByRole('list', { name: 'Empfohlen' })).toContainText('Als Zeug:in hat sich erst eine Person angemeldet')
  await expect(prepare.getByRole('list', { name: 'Nötig zum Vorbereiten' })).not.toContainText('offen')
  await shot(page, '08-vorbereiten')
})

test('Vorbereiten legt den Aufbau fest; Namen bleiben änderbar', async () => {
  await page.getByRole('button', { name: 'Vorbereiten', exact: true }).click()
  await expect(page.getByText(/^Vorbereitet · Ihre Rolle/)).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Der Wahltermin ist vorbereitet: Jetzt können Stimmkarten erzeugt werden.' })).toBeVisible()
  // Setup, members and preparing are done: each collapses to what it holds, and the cards are the step now.
  const steps = page.getByRole('navigation', { name: 'Schritte' })
  await expect(steps.locator('[aria-current="step"]')).toContainText('Stimmkarten')
  const setup = page.getByRole('region', { name: 'Einrichten' })
  const prepare = page.getByRole('region', { name: 'Vorbereiten' })
  await expect(setup).toContainText('Schulsprecher/in (3 Kandidat:innen): Paula Berger, Quirin Huber, Renate Wagner')
  await expect(setup).toContainText('Klassen und Gruppen: 1A, 2B')
  await expect(page.getByRole('region', { name: 'Mitglieder' })).toContainText('Anna Lehrerin (Wahlleitung), Carla Kollegin (Co-Admin), Wanda Zeugin (Zeug:in)')
  await expect(prepare).toContainText('Vorbereitet: welche Klassen in welchen Wahlen wählen, steht fest.')
  await prepare.getByRole('button', { name: 'Vorbereiten aufklappen' }).click()
  await expect(prepare.getByRole('button', { name: 'Zurück zum Entwurf' })).toBeVisible()
  // Names stay correctable in the setup, opened again.
  await setup.getByRole('button', { name: 'Einrichten aufklappen' }).click()
  await expect(setup.getByRole('button', { name: 'Einrichten als erledigt einklappen' })).toBeFocused()
  await expect(page.getByText('Der Wahltermin ist vorbereitet: Aufbau und Zuordnung sind festgelegt.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Wahl hinzufügen' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Klasse oder Gruppe hinzufügen' })).toHaveCount(0)

  const quirin = page.getByRole('listitem', { name: 'Quirin Huber', exact: true })
  await quirin.getByLabel('Nachname').fill('  Huber-Mayer ')
  await quirin.getByLabel('Nachname').press('Tab')
  const renamed = page.getByRole('listitem', { name: 'Quirin Huber-Mayer', exact: true })
  await expect(renamed).toBeVisible()
  await expect(renamed.getByLabel('Nachname')).toHaveValue('Huber-Mayer')
  await shot(page, '09-vorbereitet')
})

test('zurück zum Entwurf und wieder vorbereiten; ein Neuladen, das scheitert, lässt den letzten Stand stehen und versucht es wieder', async () => {
  // The reload after the change fails once, as with a dropped connection: the page keeps
  // what it showed, says so, and tries again by itself.
  await page.route('**/api/elections/*/members', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }), { times: 1 })
  await refused(page, 503, () => page.getByRole('button', { name: 'Zurück zum Entwurf' }).click())
  const offline = page.getByRole('status').filter({ hasText: 'Verbindung unterbrochen – neuer Versuch …' })
  await expect(offline).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Schulsprecherwahl 2026/27' })).toBeVisible()
  await expect(page.getByText(/^Entwurf · Ihre Rolle/)).toBeVisible()
  await expect(offline).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Zurück zum Entwurf: Aufbau und Zuordnung lassen sich wieder ändern.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Wahl hinzufügen' })).toBeVisible()
  await page.getByRole('button', { name: 'Vorbereiten', exact: true }).click()
  await expect(page.getByText(/^Vorbereitet · Ihre Rolle/)).toBeVisible()
})
