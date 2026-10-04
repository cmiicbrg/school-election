// Mitglieder: Co-Admin und Zeugin einladen; die Einladung gilt ab deren
// nächster Anmeldung, und eine Zeugin sieht dieselben Seiten ohne
// Bedienelemente.

import type { Page } from '@playwright/test'
import { expect, test } from '../support/test.ts'
import { electionId } from '../support/journey.ts'
import { ANNA, CARLA, WANDA } from '../support/personas.ts'
import { shot } from '../support/screenshot.ts'
import { openAs } from '../support/sign-in.ts'

test.describe.configure({ mode: 'serial' })

let anna: Page

test.beforeAll(async ({ browser }) => {
  anna = await (await browser.newContext()).newPage()
  await openAs(anna, ANNA, `/wahlen/${electionId()}`)
})

test.afterAll(async () => {
  await anna.context().close()
})

const members = (page: Page) => page.getByRole('region', { name: 'Mitglieder' })
const list = (page: Page) => members(page).getByRole('list', { name: 'Mitglieder' })

test('die Wahlleitung lädt einen Co-Admin und eine Zeugin ein', async () => {
  for (const [person, role] of [[CARLA, 'admin'], [WANDA, 'witness']] as const) {
    await anna.getByLabel('Schul-E-Mail-Adresse').fill(person.email ?? '')
    await anna.getByLabel('Rolle').selectOption(role)
    await anna.getByRole('button', { name: 'Einladen' }).click()
    await expect(members(anna).getByRole('status')).toContainText('gilt ab der nächsten Anmeldung')
    await expect(list(anna)).toContainText(`${person.email} · ${role === 'admin' ? 'Co-Admin' : 'Zeugin/Zeuge'} · eingeladen, noch nicht angemeldet`)
  }
  await shot(anna, '06-mitglieder-eingeladen')
})

test('die Zeugin meldet sich an, sieht die Wahl ohne Bedienelemente, und steht bei der Wahlleitung als angemeldet', async ({ browser }) => {
  const wanda = await (await browser.newContext()).newPage()
  await openAs(wanda, WANDA, `/wahlen/${electionId()}`)
  await expect(wanda.getByText(/Ihre Rolle: Zeugin\/Zeuge/)).toBeVisible()
  await expect(wanda.getByRole('region', { name: 'Einrichten' })).toBeVisible()
  await expect(wanda.getByRole('button', { name: 'Kandidat:in hinzufügen' })).toHaveCount(0)
  await expect(wanda.getByRole('button', { name: 'Einladen' })).toHaveCount(0)
  await expect(wanda.getByRole('button', { name: 'Vorbereiten' })).toHaveCount(0)
  await expect(wanda.getByRole('button', { name: 'Stimmkarten erzeugen' })).toHaveCount(0)
  await expect(list(wanda)).toContainText('Wanda Zeugin')
  await shot(wanda, '07-zeugin-sicht')
  await wanda.context().close()

  await anna.reload()
  await expect(list(anna)).toContainText('Wanda Zeugin · Zeugin/Zeuge · angemeldet · wanda.zeugin@schule.example.org')
})

test('der Co-Admin meldet sich an und darf einrichten, aber keine Mitglieder verwalten', async ({ browser }) => {
  const carla = await (await browser.newContext()).newPage()
  await openAs(carla, CARLA, `/wahlen/${electionId()}`)
  await expect(carla.getByText(/Ihre Rolle: Co-Admin/)).toBeVisible()
  await expect(carla.getByRole('button', { name: 'Kandidat:in hinzufügen' }).first()).toBeVisible()
  await expect(carla.getByRole('button', { name: 'Einladen' })).toHaveCount(0)
  await carla.context().close()
})
