// Der Wahltag im Browser: die Wahlleitung öffnet, Stimmkarten wählen am
// Handy, die Beteiligung steigt, die Wahl wird geschlossen, das Ergebnis
// steht in Worten da, ein Los entscheidet den Einzug in die Stichwahl,
// die Stichwahl läuft mit neuen Codes, ein zweites Los die
// Stellvertretungen, die Wahl wird mit Begründung abgeschlossen und
// exportiert. Die Zeugin sieht alles, ohne einen Knopf.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { devices, type BrowserContext, type Page } from '@playwright/test'
import { expect, test } from '../support/test.ts'
import { apiGet } from '../support/api.ts'
import { refused } from '../support/console.ts'
import { batchId, electionId } from '../support/journey.ts'
import { ANNA, CARLA, WANDA } from '../support/personas.ts'
import { shot } from '../support/screenshot.ts'
import { at, BASE_PATH } from '../support/base.ts'
import { openAs } from '../support/sign-in.ts'
import { voteOnPhone } from '../support/vote.ts'

test.describe.configure({ mode: 'serial' })

const SCHOOL = 'Schulsprecher/in'
const CLASS_1A = 'Klassensprecher/in 1A'
const PAULA = 'Paula Berger'
const QUIRIN = 'Quirin Huber-Mayer'
const RENATE = 'Renate Wagner'
const MAX = 'Max Fuchs'
const LENA = 'Lena Bauer'

let anna: Page
let wanda: Page
let phone: BrowserContext
let keys: string[] = []
let runoffKeys: string[] = []

test.beforeAll(async ({ browser }) => {
  anna = await (await browser.newContext()).newPage()
  await openAs(anna, ANNA, `/wahlen/${electionId()}`)
  wanda = await (await browser.newContext()).newPage()
  await openAs(wanda, WANDA, `/wahlen/${electionId()}`)
  const keysOf = async (batch: string) => (await apiGet<{ keys: { key: string }[] }>(anna, `/api/elections/${electionId()}/batches/${batch}`)).body.keys.map((entry) => entry.key)
  keys = await keysOf(batchId('1A regular'))
  runoffKeys = await keysOf(batchId('1A runoff'))
  phone = await browser.newContext({ ...devices['Pixel 7'] })
})

test.afterAll(async () => {
  await phone.close()
  await wanda.context().close()
  await anna.context().close()
})

const run = (page: Page) => page.getByRole('region', { name: 'Wahltag' })
const dialog = (name: string) => run(anna).getByRole('alertdialog', { name })
const contestResult = (page: Page, title: string) => run(page).getByRole('article', { name: title, exact: true })
/** A value an earlier spec or step must have left; the specs build on each other. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}: the specs build on each other, run them in order`)
  return value
}
const key = (index: number): string => required(keys[index], 'key')

test('die Wahlleitung öffnet die Wahl: der Dialog, dann läuft sie, und der Aufbau ist festgelegt', async () => {
  await expect(run(anna).getByTestId('state')).toHaveText('Vorbereitet. Sobald die Stimmkarten gedruckt sind, kann der 1. Wahlgang geöffnet werden.')
  await run(anna).getByRole('button', { name: '1. Wahlgang öffnen' }).click()
  await expect(dialog('1. Wahlgang öffnen?').getByRole('heading', { name: '1. Wahlgang öffnen?' })).toBeFocused()
  await expect(dialog('1. Wahlgang öffnen?')).toContainText('Ab jetzt können Stimmen abgegeben werden.')
  await expect(dialog('1. Wahlgang öffnen?')).toContainText('für den 1. Wahlgang können keine Stimmkarten mehr erzeugt oder gedruckt werden')
  // The 2B's only batch was voided by the corrections and never replaced: opening would shut it out, so it takes a second confirmation.
  await expect(dialog('1. Wahlgang öffnen?').getByRole('listitem')).toHaveText(['1A: 25 Stimmkarten', '2B: keine gültigen Stimmkarten für den 1. Wahlgang'])
  await expect(run(anna).getByRole('button', { name: '1. Wahlgang öffnen', exact: true })).toHaveCount(0)
  const openAnyway = dialog('1. Wahlgang öffnen?').getByRole('button', { name: 'Ja, 1. Wahlgang öffnen' })
  await expect(openAnyway).toBeDisabled()
  await dialog('1. Wahlgang öffnen?').getByRole('checkbox', { name: 'Trotzdem öffnen: 2B kann im 1. Wahlgang nicht wählen.' }).check()
  await shot(anna, '25-wahl-oeffnen')
  await openAnyway.click()
  await expect(run(anna).getByRole('status')).toHaveText('Der 1. Wahlgang ist geöffnet.')
  await expect(run(anna).getByTestId('state')).toHaveText('Der 1. Wahlgang läuft.')
  await expect(anna.getByText(/^1\. Wahlgang läuft · Ihre Rolle/)).toBeVisible()
  // Everything before the day is done now: the cards and the Probelauf with the opening, and the day is the step.
  await expect(anna.getByRole('navigation', { name: 'Schritte' }).locator('[aria-current="step"]')).toContainText('Wahltag')
  await expect(run(anna).getByRole('heading', { name: 'Probelauf' })).toHaveCount(0)
  await anna.getByRole('button', { name: 'Einrichten aufklappen' }).click()
  await expect(anna.getByText('Die Stimmabgabe hat begonnen: Kandidat:innen und die Stimmkarten des 1. Wahlgangs sind festgelegt.')).toBeVisible()
  // Opened only to look: the setup stays done, and the day stays the step.
  await expect(anna.getByRole('navigation', { name: 'Schritte' }).locator('[aria-current="step"]')).toContainText('Wahltag')
  await expect(run(anna).getByTestId('turnout')).toContainText('1. Wahlgang: 0 von 25 Stimmkarten verwendet')
})

test('vier Stimmkarten der 1A wählen am Handy; die Beteiligung steigt von selbst, und die Zeugin sieht sie ohne einen Knopf und kein Ergebnis', async () => {
  // First places 2, 1, 1 and twenty points each: the second place in the runoff is a lot.
  const school = [[PAULA, QUIRIN, RENATE], [PAULA, RENATE, QUIRIN], [QUIRIN, RENATE, PAULA], [RENATE, QUIRIN, PAULA]]
  const klass = [[MAX, LENA], [MAX, LENA], [MAX, LENA], [LENA, MAX]]
  for (const [index, ranking] of school.entries()) {
    await voteOnPhone(phone, key(index), [{ contest: CLASS_1A, ranking: klass[index] ?? [] }, { contest: SCHOOL, ranking }])
  }
  await expect(run(anna).getByTestId('turnout')).toContainText('1. Wahlgang: 4 von 25 Stimmkarten verwendet')
  const perContest = run(anna).getByRole('list', { name: 'Beteiligung je Wahl' })
  await expect(perContest).toContainText(`${CLASS_1A}: 4 von 25`)
  await expect(perContest).toContainText(`${SCHOOL}: 4 von 25`)
  await shot(anna, '26-beteiligung')

  // The witness's page followed the opening by itself and shows the turnout, without a control.
  await expect(run(wanda).getByTestId('state')).toHaveText('Der 1. Wahlgang läuft.')
  await expect(run(wanda).getByTestId('turnout')).toContainText('1. Wahlgang: 4 von 25 Stimmkarten verwendet')
  await expect(run(wanda).getByRole('button')).toHaveCount(0)
  await expect(run(wanda).getByRole('heading', { name: 'Ergebnis' })).toHaveCount(0)
  expect((await apiGet(wanda, `/api/elections/${electionId()}/result`)).status).toBe(409)
})

test('die Wahl schließen: der Dialog, die Versiegelung, das Ergebnis in Worten; die Stichwahl wartet auf ein Los', async () => {
  await run(anna).getByRole('button', { name: '1. Wahlgang beenden und auszählen' }).click()
  await expect(dialog('1. Wahlgang beenden und auszählen?')).toContainText('Die Stimmzettel werden versiegelt und ausgezählt. Ein beendeter Wahlgang öffnet nicht wieder.')
  await expect(dialog('1. Wahlgang beenden und auszählen?')).toContainText('21 von 25 Stimmkarten wurden nicht verwendet.')
  await shot(anna, '27-wahl-schliessen')
  await dialog('1. Wahlgang beenden und auszählen?').getByRole('button', { name: 'Ja, beenden und auszählen' }).click()
  await expect(run(anna).getByRole('status')).toHaveText('1. Wahlgang beendet: 8 Stimmzettel versiegelt und ausgezählt.')
  await expect(run(anna).getByTestId('state')).toHaveText('Der 1. Wahlgang ist beendet und ausgezählt.')
  await expect(anna.getByText(/^1\. Wahlgang ausgezählt · Ihre Rolle/)).toBeVisible()

  const klass = contestResult(anna, CLASS_1A)
  await expect(klass).toContainText('1. Wahlgang: 4 Stimmen. Erste Stellen: Max Fuchs 3, Lena Bauer 1.')
  await expect(klass).toContainText('Gewählt.')
  await expect(klass.getByRole('list', { name: `Positionen: ${CLASS_1A}` }).getByRole('listitem')).toHaveText([
    'Vertreter/in: Max Fuchs (absolute Mehrheit)',
    'Stellvertreter/in: Lena Bauer (nach Punkten)',
  ])
  const school = contestResult(anna, SCHOOL)
  await expect(school).toContainText('1. Wahlgang: 4 Stimmen. Erste Stellen: Paula Berger 2, Quirin Huber-Mayer 1, Renate Wagner 1.')
  await expect(school).toContainText('Losentscheid erforderlich.')
  await expect(school.getByTestId('lot-runoff-entry')).toContainText('Quirin Huber-Mayer und Renate Wagner sind gleichauf; das Los entscheidet, wer von ihnen in die Stichwahl kommt (ein Platz). Bereits in der Stichwahl: Paula Berger.')
  await expect(run(anna).getByRole('button', { name: 'Stichwahl aktivieren' })).toHaveCount(0)
  await shot(anna, '28-ergebnis-los')
})

test('die Zeugin sieht das Los ohne Formular; die Wahlleitung trägt die Ziehung ein, und die Stichwahl steht fest, auch auf der Seite der Zeugin', async () => {
  // The close reached the witness's page by itself.
  await expect(run(wanda).getByTestId('state')).toHaveText('Der 1. Wahlgang ist beendet und ausgezählt.')
  await expect(wanda.getByText(/^1\. Wahlgang ausgezählt · Ihre Rolle: Zeug:in/)).toBeVisible()
  const theirs = contestResult(wanda, SCHOOL)
  await expect(theirs.getByTestId('lot-runoff-entry')).toContainText('sind gleichauf')
  await expect(theirs.getByRole('form')).toHaveCount(0)

  const form = contestResult(anna, SCHOOL).getByRole('form', { name: `Losentscheid eintragen: ${SCHOOL} (Stichwahl)` })
  await form.getByLabel('1. gezogen').selectOption({ label: RENATE })
  await expect(form.getByLabel('2. gezogen').locator('option')).toHaveText(['– bitte wählen –', QUIRIN])
  // The last place fills itself, and can still be cleared to correct the order.
  await expect(form.getByLabel('2. gezogen').locator('option:checked')).toHaveText(QUIRIN)
  await form.getByLabel('2. gezogen').selectOption({ label: '– bitte wählen –' })
  await expect(form.getByLabel('2. gezogen').locator('option:checked')).toHaveText('– bitte wählen –')
  await expect(form.getByRole('button', { name: 'Losentscheid eintragen' })).toBeDisabled()
  await form.getByLabel('2. gezogen').selectOption({ label: QUIRIN })
  await expect(form.getByRole('button', { name: 'Losentscheid eintragen' })).toBeDisabled()
  await form.getByLabel('Begründung').fill('Los gezogen von der Wahlkommission am 5. Oktober')
  await shot(anna, '29-losentscheid')
  // Before anything is recorded, the form says what follows from the order.
  await form.getByRole('button', { name: 'Losentscheid eintragen' }).click()
  await expect(form).toContainText('Renate Wagner kommt in die Stichwahl; Quirin Huber-Mayer nicht. Ein eingetragener Losentscheid lässt sich nicht mehr ändern.')
  await form.getByRole('button', { name: 'Ja, eintragen' }).click()
  await expect(anna.getByRole('status').filter({ hasText: `Losentscheid für „${SCHOOL}“ eingetragen.` })).toBeVisible()
  const school = contestResult(anna, SCHOOL)
  await expect(school).toContainText('Stichwahl zwischen Paula Berger und Renate Wagner.')
  await expect(school.getByRole('list', { name: `Losentscheide: ${SCHOOL}` })).toHaveText(/^Los eingetragen von Anna Lehrerin am \d{1,2}\.\d{1,2}\.\d{4}, \d{2}:\d{2}: Renate Wagner, Quirin Huber-Mayer\. Begründung: Los gezogen von der Wahlkommission am 5\. Oktober$/)
  await expect(school.getByRole('form')).toHaveCount(0)
  // And the recorded lot reaches the witness's page by itself as well.
  await expect(theirs).toContainText('Stichwahl zwischen Paula Berger und Renate Wagner.')
  await expect(theirs.getByTestId('lot-runoff-entry')).toHaveCount(0)
})

test('Stichwahl aktivieren: der Hinweis auf die Stichwahl-Stimmkarten je Klasse, der Dialog, dann läuft sie mit neuen Codes, und die alten gelten nicht', async () => {
  const sheets = run(anna).getByRole('list', { name: 'Stichwahl-Stimmkarten' })
  await expect(sheets).toContainText('1A: 10 Stichwahl-Stimmkarten')
  await expect(sheets.getByRole('link', { name: 'Drucken (10)' })).toHaveAttribute('href', `${BASE_PATH}/elections/${electionId()}/batches/${batchId('1A runoff')}/print`)
  await expect(sheets).toContainText('Für 2B gibt es noch keine Stichwahl-Stimmkarten')
  // Establishing the result is offered too; while its dialog is open, no other step is.
  await run(anna).getByRole('button', { name: 'Ergebnis endgültig feststellen' }).click()
  await expect(run(anna).getByRole('button', { name: 'Stichwahl aktivieren' })).toHaveCount(0)
  await dialog('Ergebnis endgültig feststellen?').getByRole('button', { name: 'Abbrechen' }).click()
  await run(anna).getByRole('button', { name: 'Stichwahl aktivieren' }).click()
  await expect(dialog('Stichwahl aktivieren?')).toContainText('Die Stimmkarten des 1. Wahlgangs gelten nicht mehr')
  await expect(dialog('Stichwahl aktivieren?').getByRole('listitem')).toHaveText(['1A: 10 Stimmkarten', '2B: keine gültigen Stimmkarten für die Stichwahl'])
  await expect(dialog('Stichwahl aktivieren?').getByRole('button', { name: 'Ja, Stichwahl aktivieren' })).toBeDisabled()
  await dialog('Stichwahl aktivieren?').getByRole('checkbox', { name: 'Trotzdem aktivieren: 2B kann in der Stichwahl nicht wählen.' }).check()
  await dialog('Stichwahl aktivieren?').getByRole('button', { name: 'Ja, Stichwahl aktivieren' }).click()
  await expect(run(anna).getByRole('status')).toHaveText('Die Stichwahl läuft: 10 Stichwahl-Stimmkarten gelten jetzt.')
  await expect(run(anna).getByTestId('state')).toHaveText('Die Stichwahl läuft.')
  await expect(anna.getByText(/^Stichwahl läuft · Ihre Rolle/)).toBeVisible()
  await expect(run(anna).getByTestId('turnout')).toContainText('Stichwahl: 0 von 10 Stimmkarten verwendet')
  await shot(anna, '30-stichwahl')

  const old = await phone.newPage()
  await refused(old, 409, async () => {
    await old.goto(at(`/v#${key(5)}`))
  })
  await expect(old.getByRole('alert')).toHaveText('Die Stimmabgabe ist beendet. Es können keine Stimmen mehr abgegeben werden.')
  await old.close()
})

test('drei Stichwahl-Stimmkarten wählen; die Stichwahl schließen: Renate Wagner gewinnt, und ein zweites Los reiht die Stellvertretungen', async () => {
  for (const [index, choice] of [RENATE, RENATE, PAULA].entries()) {
    await voteOnPhone(phone, required(runoffKeys[index], 'runoff key'), [{ contest: SCHOOL, ranking: [choice] }])
  }
  await expect(run(anna).getByTestId('turnout')).toContainText('Stichwahl: 3 von 10 Stimmkarten verwendet')
  await run(anna).getByRole('button', { name: 'Stichwahl beenden und auszählen' }).click()
  await expect(dialog('Stichwahl beenden und auszählen?')).toContainText('7 von 10 Stimmkarten wurden nicht verwendet.')
  await dialog('Stichwahl beenden und auszählen?').getByRole('button', { name: 'Ja, beenden und auszählen' }).click()
  await expect(run(anna).getByRole('status')).toHaveText('Stichwahl beendet: 3 Stimmzettel versiegelt und ausgezählt.')
  await expect(run(anna).getByTestId('state')).toHaveText('Die Stichwahl ist beendet und ausgezählt.')
  await expect(anna.getByText(/^Stichwahl ausgezählt · Ihre Rolle/)).toBeVisible()

  const school = contestResult(anna, SCHOOL)
  await expect(school).toContainText('Stichwahl: 3 Stimmen. Stimmen: Renate Wagner 2, Paula Berger 1.')
  await expect(school).toContainText('Losentscheid erforderlich.')
  await expect(school.getByRole('list', { name: `Positionen: ${SCHOOL}` })).toContainText('Schulsprecher/in: Renate Wagner (Stichwahl)')
  await expect(school.getByRole('list', { name: `Positionen: ${SCHOOL}` })).toContainText('1. Stellvertretung Schulsprecher/in: wartet auf das Los')
  const lot = school.getByTestId(/^lot-positions:/)
  await expect(lot).toContainText('Paula Berger und Quirin Huber-Mayer sind gleichauf; das Los entscheidet die Reihenfolge für: 1. Stellvertretung Schulsprecher/in, 2. Stellvertretung Schulsprecher/in.')
  const form = school.getByRole('form', { name: `Losentscheid eintragen: ${SCHOOL} (Positionen)` })
  await form.getByLabel('1. gezogen').selectOption({ label: QUIRIN })
  await form.getByLabel('2. gezogen').selectOption({ label: PAULA })
  await form.getByLabel('Begründung').fill('Zweites Los der Wahlkommission')
  await form.getByRole('button', { name: 'Losentscheid eintragen' }).click()
  await expect(form).toContainText('1. Stellvertretung Schulsprecher/in: Quirin Huber-Mayer; 2. Stellvertretung Schulsprecher/in: Paula Berger.')
  await form.getByRole('button', { name: 'Ja, eintragen' }).click()
  await expect(school).toContainText('Gewählt.')
  // Three candidates fill three of the six statutory positions; the SGA's stay vacant, and the page says so.
  await expect(school.getByRole('list', { name: `Positionen: ${SCHOOL}` }).getByRole('listitem')).toHaveText([
    'Schulsprecher/in: Renate Wagner (Stichwahl)',
    '1. Stellvertretung Schulsprecher/in: Quirin Huber-Mayer (durch Los)',
    '2. Stellvertretung Schulsprecher/in: Paula Berger (durch Los)',
    '1. Stellvertretung im SGA: unbesetzt',
    '2. Stellvertretung im SGA: unbesetzt',
    '3. Stellvertretung im SGA: unbesetzt',
  ])
  await expect(school.getByRole('list', { name: `Losentscheide: ${SCHOOL}` }).getByRole('listitem')).toHaveCount(2)
  await shot(anna, '31-ergebnis')

  // The witness sees the same without a reload, and the runoff batch's codes with their use.
  await expect(contestResult(wanda, SCHOOL)).toContainText('Gewählt.')
  await expect(contestResult(wanda, SCHOOL).getByRole('form')).toHaveCount(0)
  // The cards are done once the Wahlgang opened; opened again, they show their codes.
  await wanda.getByRole('region', { name: 'Stimmkarten' }).getByRole('button', { name: 'Stimmkarten aufklappen' }).click()
  const link = wanda.getByRole('region', { name: 'Stimmkarten' }).getByTestId('batch-runoff-issued').getByRole('link', { name: 'Codes anzeigen' })
  const [codes] = await Promise.all([wanda.context().waitForEvent('page'), link.click()])
  await codes.waitForLoadState()
  await expect(codes.getByText('3 von 10 Codes wurden verwendet')).toBeVisible()
  await codes.close()
})

test('ein Co-Admin schließt nicht ab; die Wahlleitung schließt mit Begründung ab: endgültig, und nichts ändert sich mehr', async ({ browser }) => {
  const carla = await (await browser.newContext()).newPage()
  await openAs(carla, CARLA, `/wahlen/${electionId()}`)
  await expect(run(carla).getByRole('button', { name: 'Export herunterladen' })).toBeVisible()
  await expect(run(carla).getByRole('button', { name: 'Ergebnis endgültig feststellen' })).toHaveCount(0)
  await carla.context().close()

  await run(anna).getByRole('button', { name: 'Ergebnis endgültig feststellen' }).click()
  const final = dialog('Ergebnis endgültig feststellen?')
  await expect(final.getByRole('heading', { name: 'Ergebnis endgültig feststellen?' })).toBeFocused()
  // Every contest is decided here, so the dialog lists nothing as open.
  await expect(final.getByRole('list', { name: 'Noch nicht entschieden' })).toHaveCount(0)
  await expect(final).toContainText('Der Wahltermin wird abgeschlossen: nichts ändert sich mehr')
  await expect(final.getByRole('button', { name: 'Ja, Ergebnis feststellen' })).toBeDisabled()
  await final.getByLabel('Begründung').fill('Ergebnis festgestellt')
  await shot(anna, '32-abschliessen')
  await final.getByRole('button', { name: 'Ja, Ergebnis feststellen' }).click()
  // The clean-up before the declaration takes a few seconds.
  await expect(run(anna).getByRole('status')).toHaveText('Das Ergebnis ist festgestellt.', { timeout: 30_000 })
  await expect(run(anna).getByTestId('state')).toHaveText(/^Ergebnis festgestellt am \d{1,2}\.\d{1,2}\.\d{4}, \d{2}:\d{2} durch Anna Lehrerin: Ergebnis festgestellt$/)
  await expect(anna.getByText(/^Abgeschlossen · Ihre Rolle/)).toBeVisible()
  await expect(anna.getByText('Das Ergebnis ist festgestellt: nichts ändert sich mehr.')).toBeVisible()
  await expect(anna.getByRole('region', { name: 'Mitglieder' })).toContainText('Das Ergebnis ist festgestellt; Mitglieder ändern sich nicht mehr.')
  await expect(anna.getByRole('form', { name: 'Einladen' })).toHaveCount(0)
  await expect(run(anna).getByRole('button')).toHaveText(['Export herunterladen'])
  await expect(run(anna).getByRole('form')).toHaveCount(0)
  await expect(contestResult(anna, SCHOOL)).toContainText('Gewählt.')
  await shot(anna, '33-abgeschlossen')
})

test('der Export: die Datei, ihre Prüfsumme auf der Seite, auch für die Zeugin; und das Protokoll zählt den ganzen Wahltag', async () => {
  const [download] = await Promise.all([anna.waitForEvent('download'), run(anna).getByRole('button', { name: 'Export herunterladen' }).click()])
  expect(download.suggestedFilename()).toBe(`wahl-${electionId()}.json`)
  await expect(anna.getByRole('status').filter({ hasText: `Export gespeichert: wahl-${electionId()}.json.` })).toBeVisible()
  const file = await readFile(required(await download.path(), 'downloaded file'))
  const document = JSON.parse(file.toString('utf8')) as { format: string, version: number, election: { state: string }, rounds: unknown[], lots: unknown[], finalOutcomes: { kind: string }[] }
  expect([document.format, document.version, document.election.state]).toEqual(['school-election-export', 2, 'final'])
  expect([document.rounds.length, document.lots.length, document.finalOutcomes.map((entry) => entry.kind)]).toEqual([2, 2, ['final', 'final']])
  const sha256 = createHash('sha256').update(file).digest('hex')
  await expect(run(anna).getByTestId('exported')).toContainText(`Export gespeichert als wahl-${electionId()}.json. SHA-256: ${sha256}.`)
  await shot(anna, '34-export')

  await wanda.reload()
  const [theirs] = await Promise.all([wanda.waitForEvent('download'), run(wanda).getByRole('button', { name: 'Export herunterladen' }).click()])
  expect(theirs.suggestedFilename()).toBe(`wahl-${electionId()}.json`)

  const { body: audit } = await apiGet<{ events: { action: string }[], chain: { valid: boolean } }>(anna, `/api/elections/${electionId()}/audit`)
  expect(audit.chain.valid).toBe(true)
  const counts = new Map<string, number>()
  for (const event of audit.events) counts.set(event.action, (counts.get(event.action) ?? 0) + 1)
  expect(Object.fromEntries([...counts].filter(([action]) => !/^(candidate|contest|voter-group|member|lead|credential-batch|election\.(created|prepared|unprepared))/.test(action)).toSorted())).toEqual({
    'election.finalized': 1,
    'export.generated': 2,
    'lot.recorded': 2,
    'result.computed': 3,
    'round.closed': 2,
    'round.opened': 1,
    'runoff.activated': 1,
    'runoff.pair': 1,
    'test.ended': 1,
    'test.started': 1,
  })
  expect(audit.events.at(-1)?.action).toBe('export.generated')
})
