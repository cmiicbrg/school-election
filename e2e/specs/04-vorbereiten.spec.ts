// Vorbereiten: die Zusammenfassung, der Schritt, was danach noch geht
// (Namen), und der Weg zurück zum Entwurf.

import type { Page } from '@playwright/test'
import { expect, test } from '../support/test.ts'
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
  await expect(prepare.getByRole('list', { name: 'Hinweise' })).toContainText('erst eine Zeugin oder ein Zeuge angemeldet')
  await expect(prepare.getByRole('list', { name: 'Was noch fehlt' })).toHaveCount(0)
  await shot(page, '08-vorbereiten')
})

test('Vorbereiten legt den Aufbau fest; Namen bleiben änderbar', async () => {
  await page.getByRole('button', { name: 'Vorbereiten', exact: true }).click()
  await expect(page.getByText(/^Vorbereitet · Ihre Rolle/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Wahlgang hinzufügen' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Klasse oder Gruppe hinzufügen' })).toHaveCount(0)
  await expect(page.getByText('Die Wahl ist vorbereitet: Aufbau und Zuordnung sind festgelegt.')).toBeVisible()

  const quirin = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Speichern: Quirin Huber' }) })
  await quirin.getByLabel('Nachname').fill('  Huber-Mayer ')
  await quirin.getByRole('button', { name: 'Speichern: Quirin Huber' }).click()
  await expect(page.getByRole('button', { name: 'Speichern: Quirin Huber-Mayer' })).toBeVisible()
  await expect(quirin.getByLabel('Nachname')).toHaveValue('Huber-Mayer')
  await shot(page, '09-vorbereitet')
})

test('zurück zum Entwurf und wieder vorbereiten', async () => {
  await page.getByRole('button', { name: 'Zurück zum Entwurf' }).click()
  await expect(page.getByText(/^Entwurf · Ihre Rolle/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Wahlgang hinzufügen' })).toBeVisible()
  await page.getByRole('button', { name: 'Vorbereiten', exact: true }).click()
  await expect(page.getByText(/^Vorbereitet · Ihre Rolle/)).toBeVisible()
})
