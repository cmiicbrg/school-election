// Die Stimmabgabe am Handy: der Code aus dem QR-Code, die Wahlgänge, der
// Stimmzettel mit einer Zeile je Platz, das Prüfen, eine absichtlich
// ungültige Stimme, das Ende, und der Code getippt, mit Tippfehlern. Im
// Probelauf der Lehrkraft, der nichts behält. Bis die Seite Probelauf
// und Wahl selbst startet (PR 21), startet und beendet dieser Spec den
// Probelauf über die API aus Annas Seite: die eine erklärte Ausnahme von
// "alle Daten über die Seiten".

import { devices, type BrowserContext, type Page } from '@playwright/test'
import { expect, test } from '../support/test.ts'
import { apiGet, apiPost } from '../support/api.ts'
import { refused } from '../support/console.ts'
import { batchId, electionId, journey } from '../support/journey.ts'
import { ANNA } from '../support/personas.ts'
import { shot } from '../support/screenshot.ts'
import { openAs } from '../support/sign-in.ts'

test.describe.configure({ mode: 'serial' })

const SCHOOL = 'Schulsprecher/in'
const CLASS_1A = 'Klassensprecher/in 1A'

let anna: Page
let phone: BrowserContext
let page: Page
/** The keys of the 1A batch as it stands (spec 05 replaced the first one), read as the print page reads them. */
let keys: string[] = []
/** Every URL the phone requested: none of them may carry the key. */
const requested: string[] = []

test.beforeAll(async ({ browser }) => {
  anna = await (await browser.newContext()).newPage()
  await openAs(anna, ANNA, `/wahlen/${electionId()}`)
  keys = (await apiGet<{ keys: { key: string }[] }>(anna, `/api/elections/${electionId()}/batches/${batchId('1A regular')}`)).body.keys.map((entry) => entry.key)
  phone = await browser.newContext({ ...devices['Pixel 7'] })
  page = await phone.newPage()
  page.on('request', (request) => requested.push(request.url()))
})

test.afterAll(async () => {
  await phone.close()
  await anna.context().close()
})

/** The first card of the 1A batch as it stands. */
function firstKey(): string {
  const key = keys[0]
  if (!key) throw new Error('no key yet: the specs build on each other, run them in order')
  return key
}

/** The first card of the batch spec 05 replaced: a key that was printed and is void. */
function voidKey(): string {
  const key = journey().firstKey
  if (!key) throw new Error('no replaced key yet: the specs build on each other, run them in order')
  return key
}

const rounds = () => `/api/elections/${electionId()}/rounds/regular`
const contests = () => page.getByRole('list', { name: 'Wahlgänge' }).getByRole('listitem')
const row = (label: string) => page.getByLabel(label, { exact: true })

test('die Lehrkraft startet den Probelauf; der Code aus dem QR-Code verlässt die Adresse, bevor die Seite lädt', async () => {
  expect((await apiPost(anna, `${rounds()}/test`)).status).toBe(200)
  await page.goto(`/v#${firstKey()}`)
  await expect(page.getByRole('heading', { name: 'Schulsprecherwahl 2026/27' })).toBeVisible()
  await expect(page).toHaveURL('/v')
  expect(await page.evaluate(() => window.location.hash)).toBe('')
  expect(requested.filter((url) => url.includes(firstKey()))).toEqual([])
  await expect(page.getByText('Probelauf: Diese Stimmen zählen nicht.')).toBeVisible()
  await expect(contests()).toHaveText([/Klassensprecher\/in 1A/, /Schulsprecher\/in/])
  await expect(page.getByRole('status')).toHaveText('Noch 2 Wahlgänge offen.')
  await shot(page, '19-handy-wahlgaenge')
})

test('der Stimmzettel für Schulsprecher/in: drei Zeilen mit 6, 5 und 4 Punkten, ein Foto, und jede Person nur einmal', async () => {
  await page.getByRole('button', { name: `Stimmzettel ausfüllen: ${SCHOOL}` }).click()
  await expect(page.getByRole('heading', { name: SCHOOL, exact: true })).toBeFocused()
  await expect(page.getByRole('combobox')).toHaveCount(3)
  for (const label of ['6 Punkte · Schulsprecher/in', '5 Punkte · 1. Stellvertretung Schulsprecher/in', '4 Punkte · 2. Stellvertretung Schulsprecher/in']) {
    await expect(row(label)).toBeVisible()
  }
  await expect(page.getByLabel(/3 Punkte/)).toHaveCount(0)
  const candidates = page.getByRole('list', { name: 'Kandidat:innen' }).getByRole('listitem')
  await expect(candidates).toHaveCount(3)
  await expect(candidates).toContainText([/noch nicht gereiht/, /noch nicht gereiht/, /noch nicht gereiht/])
  const pictures = page.getByRole('list', { name: 'Kandidat:innen' }).locator('img')
  await expect(pictures).toHaveCount(1)
  await expect(candidates.filter({ has: page.locator('img') })).toContainText('Paula Berger')
  expect(await pictures.first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)

  // Paula for 6, then Paula for 5: she moves, and 6 is empty again.
  await row('6 Punkte · Schulsprecher/in').selectOption({ label: 'Paula Berger' })
  await expect(candidates.filter({ hasText: 'Paula Berger' })).toContainText('gereiht: 6 Punkte')
  await row('5 Punkte · 1. Stellvertretung Schulsprecher/in').selectOption({ label: 'Paula Berger' })
  await expect(row('6 Punkte · Schulsprecher/in')).toHaveValue('')
  await expect(candidates.filter({ hasText: 'Paula Berger' })).toContainText('gereiht: 5 Punkte')
  await row('6 Punkte · Schulsprecher/in').selectOption({ label: 'Paula Berger' })
  await row('5 Punkte · 1. Stellvertretung Schulsprecher/in').selectOption({ label: 'Renate Wagner' })
  await row('4 Punkte · 2. Stellvertretung Schulsprecher/in').selectOption({ label: 'Quirin Huber-Mayer' })
  await shot(page, '20-handy-stimmzettel')

  await page.getByRole('button', { name: 'Prüfen' }).click()
  await expect(page.getByRole('heading', { name: `Prüfen: ${SCHOOL}` })).toBeFocused()
  await expect(page.getByRole('list', { name: 'Ihr Stimmzettel' }).getByRole('listitem')).toHaveText([
    '6 Punkte · Schulsprecher/in: Paula Berger',
    '5 Punkte · 1. Stellvertretung Schulsprecher/in: Renate Wagner',
    '4 Punkte · 2. Stellvertretung Schulsprecher/in: Quirin Huber-Mayer',
  ])
  await expect(page.getByRole('status')).toHaveText('Gültige Stimme.')
  await shot(page, '21-handy-pruefen')
  await page.getByRole('button', { name: 'Abgeben', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Schulsprecherwahl 2026/27' })).toBeFocused()
  await expect(contests().filter({ hasText: SCHOOL })).toContainText('abgegeben')
  await expect(page.getByRole('status')).toHaveText('Noch 1 Wahlgang offen.')
})

test('der Klassensprecher-Stimmzettel mit einer leeren Zeile: ungültig, nur mit Bestätigung; die letzte Stimme beendet die Sitzung', async () => {
  await page.getByRole('button', { name: `Stimmzettel ausfüllen: ${CLASS_1A}` }).click()
  await expect(page.getByRole('combobox')).toHaveCount(2)
  await row('2 Punkte · Vertreter/in').selectOption({ label: 'Lena Bauer' })
  await page.getByRole('button', { name: 'Prüfen' }).click()
  await expect(page.getByRole('status')).toHaveText('Ungültige Stimme: 1 von 2 Zeilen ist leer. Eine ungültige Stimme zählt für niemanden.')
  await expect(page.getByRole('button', { name: 'Abgeben', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Ungültig abgeben' })).toBeDisabled()
  // Correcting keeps what was chosen.
  await page.getByRole('button', { name: 'Korrigieren' }).click()
  await expect(row('2 Punkte · Vertreter/in').locator('option:checked')).toHaveText('Lena Bauer')
  await expect(row('1 Punkt · Stellvertreter/in')).toHaveValue('')
  await page.getByRole('button', { name: 'Prüfen' }).click()
  await page.getByRole('checkbox', { name: 'Ich gebe meine Stimme absichtlich ungültig ab.' }).check()
  await shot(page, '22-handy-ungueltig')
  await page.getByRole('button', { name: 'Ungültig abgeben' }).click()
  await expect(page.getByRole('heading', { name: 'Danke!' })).toBeFocused()
  await shot(page, '23-handy-fertig')
  expect((await phone.cookies()).map((cookie) => cookie.name)).not.toContain('__Secure-voter-session')
  expect(requested.filter((url) => url.includes(firstKey()))).toEqual([])
})

test('derselbe Code getippt: Tippfehler werden vor dem Senden erkannt, die Karte eines ersetzten Stapels abgewiesen, ein verbrauchter Code zeigt, dass alles abgegeben ist', async ({ browser }) => {
  const other = await browser.newContext({ ...devices['Pixel 7'] })
  const typed = await other.newPage()
  const sent: string[] = []
  typed.on('request', (request) => {
    if (request.url().endsWith('/api/voter/session')) sent.push(request.url())
  })
  await typed.goto('/v')
  await expect(typed.getByRole('heading', { name: 'Stimmabgabe' })).toBeVisible()
  await expect(typed.getByLabel('Code')).toBeFocused()
  await shot(typed, '18-handy-code')
  const key = firstKey()

  await typed.getByLabel('Code').fill(key.slice(0, 19))
  await typed.getByRole('button', { name: 'Weiter' }).click()
  await expect(typed.getByRole('alert')).toHaveText('Der Code hat 20 Zeichen. Bitte vergleichen Sie Ihre Eingabe mit der Stimmkarte.')
  await typed.getByLabel('Code').fill(`${key.slice(0, 19)}${key[19] === 'A' ? 'B' : 'A'}`)
  await typed.getByRole('button', { name: 'Weiter' }).click()
  await expect(typed.getByRole('alert')).toHaveText('Da ist ein Tippfehler. Bitte vergleichen Sie Ihre Eingabe mit der Stimmkarte.')
  expect(sent).toEqual([])

  // The card of a replaced batch: well formed, and refused as an unknown code is.
  await typed.getByLabel('Code').fill(voidKey())
  await refused(typed, 404, () => typed.getByRole('button', { name: 'Weiter' }).click())
  await expect(typed.getByRole('alert')).toHaveText('Diesen Code gibt es nicht. Bitte vergleichen Sie Ihre Eingabe mit der Stimmkarte.')

  // Lower case with spaces, as a person types it: shown as the card prints it.
  await typed.getByLabel('Code').fill(key.toLowerCase().match(/.{1,4}/g)?.join(' ') ?? '')
  await expect(typed.getByText(key.match(/.{1,4}/g)?.join('-') ?? '', { exact: true })).toBeVisible()
  await typed.getByRole('button', { name: 'Weiter' }).click()
  await expect(typed.getByRole('status')).toHaveText('Sie haben in allen Wahlgängen abgestimmt.')
  await expect(typed.getByRole('list', { name: 'Wahlgänge' }).getByText('abgegeben')).toHaveCount(2)
  await typed.getByRole('button', { name: 'Fertig' }).click()
  await expect(typed.getByRole('heading', { name: 'Stimmabgabe' })).toBeVisible()
  await other.close()
})

test('ein zweiter Code läuft über ein Neuladen der Seite weiter; nach dem Ende des Probelaufs fängt die Seite beim Code an', async ({ browser }) => {
  const second = keys[1] ?? ''
  expect(second).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/)
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  const reloaded = await context.newPage()
  await reloaded.goto('/v')
  await reloaded.getByLabel('Code').fill(second)
  await reloaded.getByRole('button', { name: 'Weiter' }).click()
  await expect(reloaded.getByRole('status')).toHaveText('Noch 2 Wahlgänge offen.')
  await reloaded.reload()
  await expect(reloaded.getByRole('status')).toHaveText('Noch 2 Wahlgänge offen.')
  await expect(reloaded).toHaveURL('/v')

  // The test ends: the first key's two ballots, one of them invalid, are gone, its entitlements unused again.
  const ended = await apiPost<{ election: string, round: string, ballots: number, keys: number }>(anna, `${rounds()}/test/end`)
  expect(ended.body).toEqual({ election: 'prepared', round: 'planned', ballots: 2, keys: 1 })
  await refused(reloaded, 409, async () => {
    await reloaded.reload()
  })
  await expect(reloaded.getByRole('alert')).toHaveText('Die Wahl hat noch nicht begonnen. Bitte versuchen Sie es später noch einmal.')
  await context.close()
})
