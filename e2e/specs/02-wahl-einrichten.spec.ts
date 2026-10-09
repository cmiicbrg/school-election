// Eine Wahl einrichten, wie eine Lehrkraft es tut: aus der Vorlage
// anlegen, Kandidat:innen mit einem Foto eintragen, einen zweiten
// Wahlgang und die Klassen anlegen. Falsche Eingaben werden abgewiesen.

import type { Page } from '@playwright/test'
import { expect, test } from '../support/test.ts'
import { apiGet } from '../support/api.ts'
import { at, urlOf } from '../support/base.ts'
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
/** The toast that confirms a change, among the page's status messages. */
const toast = (text: string) => page.getByRole('status').filter({ hasText: text })
const candidates = (title: string) => page.getByRole('list', { name: `Kandidat:innen: ${title}` })

async function addCandidate(title: string, surname: string, givenName: string): Promise<void> {
  const form = page.getByRole('form', { name: `Kandidat:in hinzufügen: ${title}` })
  await form.getByLabel('Nachname').fill(surname)
  await form.getByLabel('Vorname').fill(givenName)
  await form.getByRole('button', { name: 'Kandidat:in hinzufügen' }).click()
  await expect(candidates(title).getByRole('listitem', { name: `${givenName} ${surname}`, exact: true })).toBeVisible()
}

/** The candidates of a contest in the order the page lists them, by the name each row carries. */
async function listed(title: string): Promise<string[]> {
  return candidates(title).getByRole('listitem').evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label') ?? ''))
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

  const paula = candidates(SCHOOL).getByRole('listitem', { name: 'Paula Berger', exact: true })
  await paula.locator('input[type="file"]').setInputFiles({ name: 'paula.png', mimeType: 'image/png', buffer: photo() })
  await expect(paula.locator('img[src*="/picture/"]')).toBeVisible()
  await expect(paula.getByRole('group', { name: 'Bild von Paula Berger' }).getByRole('status')).toHaveText('Bild gespeichert.')
  await expect(toast('Bild von Paula Berger gespeichert.')).toBeVisible()
  // A new picture answers the question about removing the old one.
  await paula.getByRole('button', { name: 'Bild entfernen' }).click()
  await expect(paula.getByRole('group', { name: 'Entfernen bestätigen: Bild von Paula Berger' })).toBeVisible()
  await paula.locator('input[type="file"]').setInputFiles({ name: 'paula-neu.png', mimeType: 'image/png', buffer: photo(600, 800) })
  await expect(paula.getByRole('group', { name: 'Entfernen bestätigen: Bild von Paula Berger' })).toHaveCount(0)
  await expect(paula.getByRole('group', { name: 'Bild von Paula Berger' }).getByRole('status')).toHaveText('Bild gespeichert.')
  await expect(paula.getByRole('button', { name: 'Bild entfernen' })).toBeEnabled()
  const { body: configuration } = await apiGet<{ contests: { title: string, candidates: { surname: string, picture: string | null }[] }[] }>(page, `/api/elections/${electionId()}/configuration`)
  const stored = configuration.contests.find((c) => c.title === SCHOOL)?.candidates.find((c) => c.surname === 'Berger')
  expect(stored?.picture).toMatch(/\/picture\/[0-9a-f]{64}$/)
  await shot(page, '04-kandidatinnen')
})

test('ein Name speichert sich beim Verlassen des Felds; was abgewiesen wird, bleibt ungespeichert, und Weggehen fragt', async () => {
  const renate = candidates(SCHOOL).getByRole('listitem', { name: 'Renate Wagner', exact: true })
  await renate.getByLabel('Nachname').fill('Ahrens')
  await expect(renate.getByText('Nicht gespeichert')).toBeVisible()
  // Leaving the field saves it. The row moves to its alphabetical place, and the focus stays where Tab took it.
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(toast('Name gespeichert: Renate Ahrens.')).toBeVisible()
  await expect.poll(() => listed(SCHOOL)).toEqual(['Renate Ahrens', 'Paula Berger', 'Quirin Huber'])
  const ahrens = candidates(SCHOOL).getByRole('listitem', { name: 'Renate Ahrens', exact: true })
  await expect(ahrens.getByRole('button', { name: 'Entfernen: Renate Ahrens' })).toBeFocused()
  await expect(ahrens.getByText('Gespeichert', { exact: true })).toBeVisible()
  // Enter saves as well.
  await ahrens.getByLabel('Nachname').fill('Wagner')
  await ahrens.getByLabel('Nachname').press('Enter')
  await expect(toast('Name gespeichert: Renate Wagner.')).toBeVisible()
  await expect.poll(() => listed(SCHOOL)).toEqual(['Paula Berger', 'Quirin Huber', 'Renate Wagner'])

  // A refused change stays unsaved, next to its reason, and leaving the page now asks first.
  await renate.getByLabel('Nachname').fill('')
  await refused(page, 400, () => renate.getByLabel('Nachname').press('Tab'))
  await expect(renate.getByRole('alert')).toContainText('Die Eingabe ist unvollständig oder zu lang.')
  await expect(renate.getByRole('button', { name: 'Noch einmal' })).toBeVisible()
  // The click waits for the question to be answered, so the answer is set up before it.
  let asked = ''
  page.once('dialog', (dialog) => {
    asked = dialog.message()
    void dialog.dismiss()
  })
  await page.getByRole('navigation', { name: 'Seiten des Wahltermins' }).getByRole('link', { name: 'Protokoll' }).click()
  expect(asked).toBe('Es gibt Änderungen, die noch nicht gespeichert sind. Seite trotzdem verlassen?')
  await expect(page).toHaveURL(urlOf(`/wahlen/${electionId()}`))
  // Put back as stored: nothing is left to save, and the refusal no longer applies.
  await renate.getByLabel('Nachname').fill('Wagner')
  await renate.getByLabel('Nachname').press('Tab')
  await expect(renate.getByRole('alert')).toHaveCount(0)
  await expect(renate.getByText('Nicht gespeichert')).toHaveCount(0)
})

test('falsche Eingaben ändern nichts: ein doppelter Name wird abgewiesen', async () => {
  const form = page.getByRole('form', { name: `Kandidat:in hinzufügen: ${SCHOOL}` })
  await form.getByLabel('Nachname').fill('Berger')
  await form.getByLabel('Vorname').fill('Paula')
  await refused(page, 409, () => form.getByRole('button', { name: 'Kandidat:in hinzufügen' }).click())
  // The refusal shows next to the form that caused it, in the contest's box.
  await expect(contest(SCHOOL).getByRole('alert')).toContainText('Diesen Namen gibt es in dieser Wahl schon.')
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

test('Entfernen fragt zuerst und nennt, was mitgeht', async () => {
  const form = page.getByRole('form', { name: 'Wahl hinzufügen' })
  await form.getByLabel('Titel der neuen Wahl').fill('Probewahl')
  await form.getByRole('button', { name: 'Wahl hinzufügen' }).click()
  await expect(toast('Wahl „Probewahl“ hinzugefügt.')).toBeVisible()
  await addCandidate('Probewahl', 'Person', 'Test')

  // Cancelled: nothing happens, and the focus is back on the button that asked.
  const remove = candidates('Probewahl').getByRole('button', { name: 'Entfernen: Test Person' })
  await remove.click()
  const asked = page.getByRole('group', { name: 'Entfernen bestätigen: Test Person' })
  await expect(asked).toContainText('Test Person entfernen?')
  await expect(asked.getByRole('button', { name: 'Abbrechen' })).toBeFocused()
  await asked.getByRole('button', { name: 'Abbrechen' }).click()
  await expect(asked).toHaveCount(0)
  await expect(remove).toBeFocused()

  // Confirmed: the contest goes with its candidate, as the question said.
  await contest('Probewahl').getByRole('button', { name: 'Wahl entfernen: Probewahl' }).click()
  const contestAsked = page.getByRole('group', { name: 'Entfernen bestätigen: Probewahl' })
  await expect(contestAsked).toContainText('Wahl „Probewahl“ mit 1 Kandidat:in entfernen?')
  await contestAsked.getByRole('button', { name: 'Ja, entfernen' }).click()
  await expect(toast('Wahl „Probewahl“ entfernt.')).toBeVisible()
  await expect(contest('Probewahl')).toHaveCount(0)
})

test('die Klassen und was sie wählen', async () => {
  const form = page.getByRole('form', { name: 'Klasse oder Gruppe hinzufügen' })
  for (const name of ['1A', '2B']) {
    await form.getByLabel('Name der Klasse oder Gruppe').fill(name)
    await form.getByRole('button', { name: 'Klasse oder Gruppe hinzufügen' }).click()
    await expect(page.getByRole('article', { name, exact: true })).toBeVisible()
  }
  // The checklist says what is still open, neutrally; preparing is refused while a class votes
  // nowhere, and then the page says so, until it is supplied.
  const preparing = page.getByRole('region', { name: 'Vorbereiten' })
  const missing = preparing.getByRole('list', { name: 'Nötig zum Vorbereiten' })
  await expect(missing).toContainText('Eine Wahl ist angelegt: erledigt')
  await expect(missing).toContainText('Jede Klasse oder Gruppe wählt in einer Wahl: offen')
  await expect(preparing.getByRole('alert')).toHaveCount(0)
  await refused(page, 409, () => page.getByRole('button', { name: 'Vorbereiten', exact: true }).click())
  await expect(preparing.getByRole('alert')).toHaveText('Vorbereiten geht noch nicht: Was oben rot steht, fehlt noch.')
  await expect(missing).toContainText('Die Klasse oder Gruppe „1A“ wählt in keiner Wahl.')
  // A change that leaves the same missing keeps it red; one that supplies something clears it.
  await page.getByRole('region', { name: 'Einrichten' }).getByLabel('Beschreibung').fill('Wahl am 5. Oktober im Festsaal, ab 8 Uhr')
  await page.getByRole('region', { name: 'Einrichten' }).getByLabel('Beschreibung').press('Tab')
  await expect(toast('Titel und Beschreibung gespeichert.')).toBeVisible()
  await expect(preparing.getByRole('alert')).toBeVisible()
  await assignContest(page, '1A', SCHOOL)
  await expect(toast(`„1A“ wählt jetzt in „${SCHOOL}“.`)).toBeVisible()
  await assignContest(page, '1A', CLASS_1A)
  await assignContest(page, '2B', SCHOOL)
  await expect(page.getByRole('article', { name: '2B', exact: true }).getByRole('checkbox', { name: CLASS_1A })).not.toBeChecked()
  // While the draft is editable, only the forms show, not the read-only summaries beside them.
  await expect(page.getByRole('article', { name: '1A', exact: true }).getByText(/^Wählt in:/)).toHaveCount(0)
  await expect(contest(SCHOOL).getByRole('heading', { level: 4 })).toHaveCount(0)
  await expect(missing).not.toContainText('offen')
  await expect(preparing.getByRole('alert')).toHaveCount(0)
  await shot(page, '05-klassen')

  const { body: configuration } = await apiGet<{ voterGroups: { name: string, contestIds: string[] }[] }>(page, `/api/elections/${electionId()}/configuration`)
  expect(configuration.voterGroups.map((group) => [group.name, group.contestIds.length])).toEqual([['1A', 2], ['2B', 1]])
})

test('ein Übungstermin, den niemand gebraucht hat, lässt sich löschen, nach einer Rückfrage', async () => {
  await page.goto(at('/wahlen/neu'))
  await page.getByLabel('Titel des Wahltermins').fill('Übungstermin')
  await page.getByRole('radio', { name: 'Schulsprecherwahl', exact: true }).check()
  await page.getByRole('button', { name: 'Wahltermin anlegen' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Übungstermin' })).toBeVisible()
  // Something typed and not added: once the termin is gone, nothing asks to stay on it.
  await page.getByRole('form', { name: `Kandidat:in hinzufügen: ${SCHOOL}` }).getByLabel('Nachname').fill('Muster')
  await page.getByRole('button', { name: 'Wahltermin löschen' }).click()
  const asked = page.getByRole('group', { name: 'Löschen bestätigen: Wahltermin' })
  await expect(asked).toContainText('Wahltermin „Übungstermin“ endgültig löschen?')
  await expect(asked.getByRole('button', { name: 'Abbrechen' })).toBeFocused()
  await asked.getByRole('button', { name: 'Ja, löschen' }).click()
  await expect(page).toHaveURL(urlOf('/'))
  await expect(page.getByRole('status').filter({ hasText: 'Wahltermin „Übungstermin“ gelöscht.' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Übungstermin' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: TITLE })).toBeVisible()
})
