// Die Stimmabgabe am Handy: der Code aus dem QR-Code, die Wahlgänge, der
// Stimmzettel mit einer Zeile je Platz, das Prüfen, eine absichtlich
// ungültige Stimme, das Ende, und der Code getippt, mit Tippfehlern. Im
// Probelauf der Lehrkraft, den sie auf ihrer Seite startet, beobachtet
// und beendet, und der nichts behält.

import { devices, type BrowserContext, type Page } from '@playwright/test'
import { expect, test } from '../support/test.ts'
import { apiGet } from '../support/api.ts'
import { expectFailure, refused } from '../support/console.ts'
import { batchId, electionId, journey } from '../support/journey.ts'
import { ANNA } from '../support/personas.ts'
import { shot } from '../support/screenshot.ts'
import { at, BASE_PATH, urlOf } from '../support/base.ts'
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

const run = () => anna.getByRole('region', { name: 'Wahltag' })
const contests = () => page.getByRole('list', { name: 'Wahlen' }).getByRole('listitem')
const row = (label: string) => page.getByLabel(label, { exact: true })

test('die Lehrkraft startet den Probelauf; der Code aus dem QR-Code verlässt die Adresse, bevor die Seite lädt', async () => {
  await expect(run().getByTestId('state')).toHaveText('Vorbereitet. Sobald die Stimmkarten gedruckt sind, kann der 1. Wahlgang geöffnet werden.')
  await run().getByRole('button', { name: 'Probelauf starten' }).click()
  await expect(run().getByRole('status')).toHaveText('Probelauf gestartet: Stimmen zählen nicht, und nichts bleibt.')
  await expect(run().getByTestId('state')).toHaveText('Der Probelauf läuft: Stimmen zählen nicht, und nichts bleibt.')
  await expect(anna.getByText(/^Probelauf · Ihre Rolle: Wahlleitung/)).toBeVisible()
  // The Probelauf is the step of the moment: starting it finished the cards, although nobody marked them done in this browser.
  const steps = anna.getByRole('navigation', { name: 'Schritte' })
  await expect(steps.locator('[aria-current="step"]')).toContainText('Probelauf')
  await expect(steps.getByRole('listitem').filter({ hasText: 'Stimmkarten' })).toContainText('(erledigt)')
  // While it runs the page leads with the day, and a banner says so.
  await expect(anna.getByRole('region').first()).toHaveAccessibleName('Wahltag')
  await expect(anna.getByText('Probelauf läuft.', { exact: true })).toBeVisible()
  await anna.getByRole('link', { name: 'Zum Probelauf' }).click()
  await expect(run().getByRole('heading', { name: 'Probelauf' })).toBeFocused()
  await expect(run().getByTestId('turnout')).toContainText('1. Wahlgang: 0 von 25 Stimmkarten verwendet')
  await shot(anna, '24-probelauf')
  await page.goto(at(`/v#${firstKey()}`))
  await expect(page.getByRole('heading', { name: 'Schulsprecherwahl 2026/27' })).toBeVisible()
  await expect(page).toHaveURL(urlOf('/v'))
  expect(await page.evaluate(() => window.location.hash)).toBe('')
  expect(requested.filter((url) => url.includes(firstKey()))).toEqual([])
  await expect(page.getByText('Probelauf: Diese Stimmen zählen nicht.')).toBeVisible()
  await expect(contests()).toHaveText([/Klassensprecher\/in 1A/, /Schulsprecher\/in/])
  await expect(page.getByRole('status')).toHaveText('Noch 2 Wahlen offen.')
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
  await expect(page.getByRole('status')).toHaveText('Noch 1 Wahl offen.')
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

  // The teacher's page: one card used, and the rehearsal's count so far, the invalid vote counted as such.
  await expect(run().getByTestId('turnout')).toContainText('1. Wahlgang: 1 von 25 Stimmkarten verwendet')
  await run().getByRole('button', { name: 'Zwischenstand' }).click()
  const interim = run().getByRole('list', { name: 'Zwischenstand' })
  await expect(interim).toContainText(`${CLASS_1A}: 1 Stimme, davon 1 ungültig.`)
  await expect(interim).toContainText(`${SCHOOL}: 1 Stimme. Erste Stellen: Paula Berger 1, Quirin Huber-Mayer 0, Renate Wagner 0.`)
})

test('derselbe Code getippt: Tippfehler werden vor dem Senden erkannt, die Karte eines ersetzten Stapels abgewiesen, ein verbrauchter Code zeigt, dass alles abgegeben ist', async ({ browser }) => {
  const other = await browser.newContext({ ...devices['Pixel 7'] })
  const typed = await other.newPage()
  const sent: string[] = []
  typed.on('request', (request) => {
    if (request.url().endsWith('/api/voter/session')) sent.push(request.url())
  })
  await typed.goto(at('/v'))
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
  await expect(typed.getByRole('status')).toHaveText('Sie haben in allen Wahlen abgestimmt.')
  await expect(typed.getByRole('list', { name: 'Wahlen' }).getByText('abgegeben')).toHaveCount(2)
  // "Fertig" that does not reach the server leaves the page as it is: the cookie is still there.
  await other.route('**/api/voter/session/end', (route) => route.abort())
  expectFailure(new URL(`${BASE_PATH}/api/voter/session/end`, typed.url()).toString())
  await typed.getByRole('button', { name: 'Fertig' }).click()
  await expect(typed.getByRole('alert')).toHaveText('Das hat nicht geklappt. Bitte versuchen Sie es noch einmal.')
  await expect(typed.getByRole('status')).toHaveText('Sie haben in allen Wahlen abgestimmt.')
  await other.unroute('**/api/voter/session/end')
  await typed.getByRole('button', { name: 'Fertig' }).click()
  await expect(typed.getByRole('heading', { name: 'Stimmabgabe' })).toBeVisible()
  expect((await other.cookies()).map((cookie) => cookie.name)).not.toContain('__Secure-voter-session')
  await other.close()
})

test('ein zweiter Code läuft über ein Neuladen der Seite weiter; nach dem Ende des Probelaufs fängt die Seite beim Code an', async ({ browser }) => {
  const second = keys[1] ?? ''
  expect(second).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/)
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  const reloaded = await context.newPage()
  await reloaded.goto(at('/v'))
  await reloaded.getByLabel('Code').fill(second)
  await reloaded.getByRole('button', { name: 'Weiter' }).click()
  await expect(reloaded.getByRole('status')).toHaveText('Noch 2 Wahlen offen.')
  await reloaded.reload()
  await expect(reloaded.getByRole('status')).toHaveText('Noch 2 Wahlen offen.')
  await expect(reloaded).toHaveURL(urlOf('/v'))

  // A third card scanned into the same tab, while the page is on a ballot: the browser changes the
  // fragment without loading the page again; the ballot is gone at once, the key leaves the address
  // all the same, and the page starts over with the new session.
  const [third, fourth, fifth] = [keys[2] ?? '', keys[3] ?? '', keys[4] ?? '']
  const cookieOf = async () => (await context.cookies()).find((cookie) => cookie.name === '__Secure-voter-session')?.value
  const before = await cookieOf()
  const urls: string[] = []
  const redeemed: string[] = []
  reloaded.on('request', (request) => {
    urls.push(request.url())
    if (request.url().endsWith('/api/voter/session')) redeemed.push((request.postDataJSON() as { key: string }).key)
  })
  await reloaded.getByRole('button', { name: `Stimmzettel ausfüllen: ${SCHOOL}` }).click()
  await reloaded.getByLabel('6 Punkte · Schulsprecher/in', { exact: true }).selectOption({ label: 'Paula Berger' })
  // The answer takes a moment, as on a slow network: meanwhile nothing of the ballot is shown.
  await context.route('**/api/voter/session', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600))
    await route.continue()
  })
  await reloaded.evaluate((key) => {
    window.location.hash = `#${key}`
  }, third)
  await expect(reloaded.getByRole('status')).toHaveText('Einen Moment …')
  await expect(reloaded.getByRole('combobox')).toHaveCount(0)
  // Two more cards before that answer is in: only the last of them is redeemed, after the third's answer, which is dropped.
  await expect.poll(() => redeemed).toEqual([third])
  await reloaded.evaluate(([a, b]) => {
    window.location.hash = `#${a}`
    window.location.hash = `#${b}`
  }, [fourth, fifth])
  await expect(reloaded.getByRole('status')).toHaveText('Noch 2 Wahlen offen.')
  await context.unroute('**/api/voter/session')
  expect(redeemed).toEqual([third, fifth])
  await expect.poll(cookieOf).not.toBe(before)
  await expect(reloaded).toHaveURL(urlOf('/v'))
  expect(await reloaded.evaluate(() => window.location.hash)).toBe('')
  expect(urls.filter((url) => url.includes(third) || url.includes(fourth) || url.includes(fifth))).toEqual([])

  // A card scanned while a ballot is on its way: the ballot's answer comes first, the new card is redeemed after it.
  const sixth = keys[5] ?? ''
  await reloaded.getByRole('button', { name: `Stimmzettel ausfüllen: ${CLASS_1A}` }).click()
  await reloaded.getByLabel('2 Punkte · Vertreter/in', { exact: true }).selectOption({ label: 'Lena Bauer' })
  await reloaded.getByLabel('1 Punkt · Stellvertreter/in', { exact: true }).selectOption({ label: 'Max Fuchs' })
  await reloaded.getByRole('button', { name: 'Prüfen' }).click()
  await context.route('**/api/voter/ballot', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600))
    await route.continue()
  })
  const order: string[] = []
  reloaded.on('request', (request) => {
    const match = /\/api\/voter\/(ballot|session)$/.exec(request.url())
    if (match?.[1]) order.push(match[1])
  })
  await reloaded.getByRole('button', { name: 'Abgeben', exact: true }).click()
  await reloaded.evaluate((key) => {
    window.location.hash = `#${key}`
  }, sixth)
  await expect(reloaded.getByRole('status')).toHaveText('Einen Moment …')
  await expect(reloaded.getByRole('status')).toHaveText('Noch 2 Wahlen offen.')
  await context.unroute('**/api/voter/ballot')
  expect(order).toEqual(['ballot', 'session'])

  // The test ends on the teacher's page: the first key's two ballots, one of them invalid, and the fifth's one are gone, their entitlements unused again.
  await run().getByRole('button', { name: 'Probelauf beenden' }).click()
  await expect(run().getByRole('status')).toHaveText('Probelauf beendet: 3 Stimmzettel entfernt, 2 Codes wieder frei.')
  await expect(run().getByTestId('state')).toHaveText('Vorbereitet. Sobald die Stimmkarten gedruckt sind, kann der 1. Wahlgang geöffnet werden.')
  // The cards stay done after it, and the Probelauf is the step again, until it is marked done.
  await expect(anna.getByRole('navigation', { name: 'Schritte' }).getByRole('listitem').filter({ hasText: 'Stimmkarten' })).toContainText('(erledigt)')
  await expect(anna.getByRole('navigation', { name: 'Schritte' }).locator('[aria-current="step"]')).toContainText('Probelauf')

  // Enough testing: the Probelauf is marked done and collapses.
  await run().getByRole('button', { name: 'Probelauf als erledigt einklappen' }).click()
  await expect(run().getByRole('button', { name: 'Probelauf aufklappen' })).toHaveAttribute('aria-expanded', 'false')
  await expect(run()).toContainText('Erledigt oder übersprungen.')
  await expect(run().getByRole('button', { name: 'Probelauf starten' })).toHaveCount(0)
  await expect(anna.getByRole('navigation', { name: 'Schritte' }).getByRole('listitem').filter({ hasText: 'Probelauf' })).toContainText('(erledigt)')
  await refused(reloaded, 409, async () => {
    await reloaded.reload()
  })
  await expect(reloaded.getByRole('alert')).toHaveText('Die Stimmabgabe hat noch nicht begonnen. Bitte versuchen Sie es später noch einmal.')
  await context.close()
})
