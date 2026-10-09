// Mitglieder: Co-Admin und Zeugin einladen; die Einladung gilt ab deren
// nächster Anmeldung, und eine Zeugin sieht dieselben Seiten ohne
// Bedienelemente. Ein Co-Admin lädt Zeug:innen ein und entfernt sie, aber
// keine Co-Admins. Die Wahlleitung geht an den Co-Admin und zurück.

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
    await expect(list(anna)).toContainText(`${person.email} · ${role === 'admin' ? 'Co-Admin' : 'Zeug:in'} · eingeladen, noch nicht angemeldet`)
  }
  const form = members(anna).getByRole('form', { name: 'Einladen' })
  await expect(form).toContainText('Es wird keine E-Mail verschickt')
  await expect(form.getByRole('combobox', { name: 'Rolle' })).toHaveAccessibleDescription('Sieht alles, ändert nichts; die Stimmkarten erst, wenn ihr Wahlgang beendet ist.')
  await form.getByLabel('Rolle').selectOption('admin')
  await expect(form).toContainText('Meist genügt eine Person als Co-Admin; dieser Wahltermin hat schon eine.')
  await form.getByLabel('Rolle').selectOption('witness')
  await shot(anna, '06-mitglieder-eingeladen')
})

test('die Zeugin meldet sich an, sieht die Wahl ohne Bedienelemente, und steht bei der Wahlleitung als angemeldet', async ({ browser }) => {
  const wanda = await (await browser.newContext()).newPage()
  await openAs(wanda, WANDA, `/wahlen/${electionId()}`)
  await expect(wanda.getByText(/Ihre Rolle: Zeug:in · Wahlleitung: Anna Lehrerin$/)).toBeVisible()
  await expect(wanda.getByRole('region', { name: 'Einrichten' })).toBeVisible()
  await expect(wanda.getByRole('button', { name: 'Kandidat:in hinzufügen' })).toHaveCount(0)
  await expect(wanda.getByRole('button', { name: 'Einladen' })).toHaveCount(0)
  await expect(wanda.getByRole('button', { name: 'Vorbereiten' })).toHaveCount(0)
  await expect(wanda.getByRole('button', { name: 'Stimmkarten erzeugen' })).toHaveCount(0)
  await expect(list(wanda)).toContainText('Wanda Zeugin')
  await shot(wanda, '07-zeugin-sicht')
  await wanda.context().close()

  await anna.reload()
  await expect(list(anna)).toContainText('Wanda Zeugin · Zeug:in · angemeldet · wanda.zeugin@schule.example.org')
})

test('Entfernen fragt zuerst; abgebrochen bleibt, wer eingeladen ist', async () => {
  const remove = list(anna).getByRole('button', { name: 'Entfernen: Wanda Zeugin' })
  await remove.click()
  const asked = list(anna).getByRole('group', { name: 'Entfernen bestätigen: Wanda Zeugin' })
  await expect(asked).toContainText('Wanda Zeugin (Zeug:in) entfernen?')
  await expect(asked.getByRole('button', { name: 'Abbrechen' })).toBeFocused()
  await asked.getByRole('button', { name: 'Abbrechen' }).click()
  await expect(asked).toHaveCount(0)
  await expect(remove).toBeFocused()
  await expect(list(anna)).toContainText('Wanda Zeugin · Zeug:in · angemeldet')
})

test('der Co-Admin meldet sich an, darf einrichten und Zeug:innen einladen, aber keine Co-Admins', async ({ browser }) => {
  const carla = await (await browser.newContext()).newPage()
  await openAs(carla, CARLA, `/wahlen/${electionId()}`)
  await expect(carla.getByText(/Ihre Rolle: Co-Admin · Wahlleitung: Anna Lehrerin$/)).toBeVisible()
  await expect(carla.getByRole('button', { name: 'Kandidat:in hinzufügen' }).first()).toBeVisible()
  const form = members(carla).getByRole('form', { name: 'Einladen' })
  await expect(form.getByRole('button', { name: 'Einladen' })).toBeVisible()
  await expect(form.getByRole('combobox', { name: 'Rolle' }).getByRole('option')).toHaveText(['Zeug:in'])
  await expect(list(carla).getByRole('button', { name: 'Entfernen: Wanda Zeugin' })).toBeVisible()
  await expect(list(carla).getByRole('button', { name: /^Entfernen: (Anna Lehrerin|Carla Kollegin)$/ })).toHaveCount(0)
  await carla.context().close()
})

test('die Wahlleitung geht an den angemeldeten Co-Admin und wieder zurück; die Übergabe fragt zuerst', async ({ browser }) => {
  await anna.reload()
  const handOver = list(anna).getByRole('button', { name: 'Wahlleitung übergeben: Carla Kollegin' })
  await expect(list(anna).getByRole('button', { name: /^Wahlleitung übergeben: / })).toHaveCount(1)
  await handOver.click()
  const asked = list(anna).getByRole('group', { name: 'Übergabe bestätigen: Carla Kollegin' })
  await expect(asked).toContainText('Wahlleitung an Carla Kollegin übergeben? Sie werden Co-Admin; das Ergebnis feststellen, den Wahltermin löschen und Co-Admins verwalten kann dann nur noch Carla Kollegin.')
  await expect(asked.getByRole('button', { name: 'Abbrechen' })).toBeFocused()
  await shot(anna, '07b-wahlleitung-uebergeben')
  // Co-Admin chosen in the form, then the lead handed over: the form invites witnesses.
  await members(anna).getByLabel('Rolle').selectOption('admin')
  await asked.getByRole('button', { name: 'Ja, übergeben' }).click()
  await expect(anna.getByRole('status').filter({ hasText: 'Wahlleitung an Carla Kollegin übergeben. Sie sind jetzt Co-Admin.' })).toBeVisible()
  await expect(anna.getByText(/Ihre Rolle: Co-Admin · Wahlleitung: Carla Kollegin$/)).toBeVisible()
  await expect(list(anna)).toContainText('Carla Kollegin · Wahlleitung')
  await expect(list(anna)).toContainText('Anna Lehrerin · Co-Admin · angemeldet')
  await expect(members(anna).getByRole('combobox', { name: 'Rolle' }).getByRole('option')).toHaveText(['Zeug:in'])
  await expect(members(anna).getByRole('combobox', { name: 'Rolle' })).toHaveValue('witness')
  await expect(list(anna).getByRole('button', { name: /^(Wahlleitung übergeben|Entfernen): (Anna Lehrerin|Carla Kollegin)$/ })).toHaveCount(0)

  const carla = await (await browser.newContext()).newPage()
  await openAs(carla, CARLA, `/wahlen/${electionId()}`)
  await expect(carla.getByText(/^Entwurf · Ihre Rolle: Wahlleitung$/)).toBeVisible()
  await list(carla).getByRole('button', { name: 'Wahlleitung übergeben: Anna Lehrerin' }).click()
  await list(carla).getByRole('group', { name: 'Übergabe bestätigen: Anna Lehrerin' }).getByRole('button', { name: 'Ja, übergeben' }).click()
  await expect(carla.getByText(/Ihre Rolle: Co-Admin · Wahlleitung: Anna Lehrerin$/)).toBeVisible()
  await carla.context().close()

  await anna.reload()
  await expect(anna.getByText(/^Entwurf · Ihre Rolle: Wahlleitung$/)).toBeVisible()
  await expect(list(anna)).toContainText('Carla Kollegin · Co-Admin · angemeldet')
})
