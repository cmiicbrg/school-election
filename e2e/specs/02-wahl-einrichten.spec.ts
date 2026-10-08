// Eine Wahl einrichten, wie eine Lehrkraft es tut: aus der Vorlage
// anlegen, Kandidat:innen mit einem Foto eintragen, einen zweiten
// Wahlgang und die Klassen anlegen. Falsche Eingaben werden abgewiesen.

import type { Page } from '@playwright/test'
import { expect, test } from '../support/test.ts'
import { apiGet } from '../support/api.ts'
import { assignContest } from '../support/classes.ts'
import { refused } from '../support/console.ts'
import { electionId, remember } from '../support/journey.ts'
import { ANNA } from '../support/personas.ts'
import { photo } from '../support/picture.ts'
import { shot } from '../support/screenshot.ts'
import { openAs } from '../support/sign-in.ts'

test.describe.configure({ mode: 'serial' })

const TITLE = 'Schulsprecherwahl 2026/27'
const SCHOOL = 'Schulsprecher/in'
const CLASS_1A = 'Klassensprecher/in 1A'

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage()
})

test.afterAll(async () => {
  await page.context().close()
})

const contest = (title: string) => page.getByRole('article', { name: title, exact: true })
const candidates = (title: string) => page.getByRole('list', { name: `Kandidat:innen: ${title}` })

async function addCandidate(title: string, surname: string, givenName: string): Promise<void> {
  const form = page.getByRole('form', { name: `Kandidat:in hinzufügen: ${title}` })
  await form.getByLabel('Nachname').fill(surname)
  await form.getByLabel('Vorname').fill(givenName)
  await form.getByRole('button', { name: 'Kandidat:in hinzufügen' }).click()
  await expect(candidates(title).getByRole('button', { name: `Speichern: ${givenName} ${surname}` })).toBeVisible()
}

/** The candidates of a contest in the order the page lists them, by the name on their "Speichern" button. */
async function listed(title: string): Promise<string[]> {
  const names = await candidates(title).getByRole('button', { name: /^Speichern: / }).evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('aria-label') ?? ''))
  return names.map((name) => name.replace('Speichern: ', ''))
}

test('eine neue Wahl aus der Vorlage Schulsprecherwahl', async () => {
  await openAs(page, ANNA, '/wahlen/neu')
  await page.getByLabel('Titel des Wahltermins').fill(TITLE)
  await page.getByLabel('Beschreibung (optional)').fill('Wahl am 5. Oktober im Festsaal')
  await page.getByRole('radio', { name: 'Schulsprecherwahl', exact: true }).check()
  await shot(page, '03-neue-wahl')
  await page.getByRole('button', { name: 'Wahltermin anlegen' }).click()
  await expect(page).toHaveURL(/\/wahlen\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible()
  await expect(page.getByText(/^Entwurf · Ihre Rolle: Wahlleitung/)).toBeVisible()
  await expect(page).toHaveTitle(`${TITLE} – Schulwahl`)
  await expect(contest(SCHOOL)).toBeVisible()
  remember({ electionId: page.url().split('/').pop(), title: TITLE })
})

test('Kandidat:innen, in der Reihenfolge des Stimmzettels, eine mit Foto', async () => {
  await addCandidate(SCHOOL, 'Wagner', 'Renate')
  await addCandidate(SCHOOL, 'Berger', 'Paula')
  await addCandidate(SCHOOL, 'Huber', 'Quirin')
  expect(await listed(SCHOOL)).toEqual(['Paula Berger', 'Quirin Huber', 'Renate Wagner'])

  const paula = candidates(SCHOOL).getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Speichern: Paula Berger' }) })
  await paula.locator('input[type="file"]').setInputFiles({ name: 'paula.png', mimeType: 'image/png', buffer: photo() })
  await expect(paula.locator('img[src*="/picture/"]')).toBeVisible()
  const { body: configuration } = await apiGet<{ contests: { title: string, candidates: { surname: string, picture: string | null }[] }[] }>(page, `/api/elections/${electionId()}/configuration`)
  const stored = configuration.contests.find((c) => c.title === SCHOOL)?.candidates.find((c) => c.surname === 'Berger')
  expect(stored?.picture).toMatch(/\/picture\/[0-9a-f]{64}$/)
  await shot(page, '04-kandidatinnen')
})

test('falsche Eingaben ändern nichts: ein doppelter Name wird abgewiesen', async () => {
  const form = page.getByRole('form', { name: `Kandidat:in hinzufügen: ${SCHOOL}` })
  await form.getByLabel('Nachname').fill('Berger')
  await form.getByLabel('Vorname').fill('Paula')
  await refused(page, 409, () => form.getByRole('button', { name: 'Kandidat:in hinzufügen' }).click())
  await expect(page.getByRole('alert')).toContainText('Diesen Namen gibt es in dieser Wahl schon.')
  expect(await listed(SCHOOL)).toEqual(['Paula Berger', 'Quirin Huber', 'Renate Wagner'])
  await form.getByLabel('Nachname').fill('')
  await form.getByLabel('Vorname').fill('')
})

test('ein zweiter Wahlgang mit zwei Kandidat:innen', async () => {
  const form = page.getByRole('form', { name: 'Wahl hinzufügen' })
  await form.getByLabel('Titel der neuen Wahl').fill(CLASS_1A)
  await form.getByLabel('Regeln').selectOption({ label: 'Vertretung und Stellvertretung: zwei Reihungen, 2 und 1 Punkt' })
  await form.getByRole('button', { name: 'Wahl hinzufügen' }).click()
  await expect(contest(CLASS_1A)).toBeVisible()
  await addCandidate(CLASS_1A, 'Fuchs', 'Max')
  await addCandidate(CLASS_1A, 'Bauer', 'Lena')
  expect(await listed(CLASS_1A)).toEqual(['Lena Bauer', 'Max Fuchs'])
})

test('die Klassen und was sie wählen', async () => {
  const form = page.getByRole('form', { name: 'Klasse oder Gruppe hinzufügen' })
  for (const name of ['1A', '2B']) {
    await form.getByLabel('Name der Klasse oder Gruppe').fill(name)
    await form.getByRole('button', { name: 'Klasse oder Gruppe hinzufügen' }).click()
    await expect(page.getByRole('article', { name, exact: true })).toBeVisible()
  }
  // Preparing is refused while a class votes nowhere; what is missing is listed until it is supplied.
  const missing = page.getByRole('region', { name: 'Vorbereiten' }).getByRole('list', { name: 'Was noch fehlt' })
  await refused(page, 409, () => page.getByRole('button', { name: 'Vorbereiten', exact: true }).click())
  await expect(missing).toContainText('Die Klasse oder Gruppe „1A“ wählt in keiner Wahl.')
  await assignContest(page, '1A', SCHOOL)
  await assignContest(page, '1A', CLASS_1A)
  await assignContest(page, '2B', SCHOOL)
  await expect(page.getByRole('article', { name: '2B', exact: true }).getByRole('checkbox', { name: CLASS_1A })).not.toBeChecked()
  await expect(missing).toHaveCount(0)
  await shot(page, '05-klassen')

  const { body: configuration } = await apiGet<{ voterGroups: { name: string, contestIds: string[] }[] }>(page, `/api/elections/${electionId()}/configuration`)
  expect(configuration.voterGroups.map((group) => [group.name, group.contestIds.length])).toEqual([['1A', 2], ['2B', 1]])
})
