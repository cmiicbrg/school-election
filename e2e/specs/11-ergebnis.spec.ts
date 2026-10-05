// Was die Zeugin nach der Wahl liest: das Ergebnis mit den Zahlen jeder
// Runde und jedem Schritt der Herleitung in Worten, die Losentscheide,
// die Versionen; das Protokoll mit seiner Kette; und die Hilfe zum
// Wahltag, über die Links der Wahl.

import type { Page } from '@playwright/test'
import { expect, test } from '../support/test.ts'
import { apiGet } from '../support/api.ts'
import { electionId } from '../support/journey.ts'
import { WANDA } from '../support/personas.ts'
import { shot } from '../support/screenshot.ts'
import { openAs } from '../support/sign-in.ts'

test.describe.configure({ mode: 'serial' })

const SCHOOL = 'Schulsprecher/in'
const CLASS_1A = 'Klassensprecher/in 1A'

let wanda: Page

test.beforeAll(async ({ browser }) => {
  wanda = await (await browser.newContext()).newPage()
  await openAs(wanda, WANDA, `/wahlen/${electionId()}`)
})

test.afterAll(async () => {
  await wanda.context().close()
})

const article = (title: string) => wanda.getByRole('article', { name: title, exact: true })

test('das Ergebnis: die Zahlen jeder Runde als Tabelle, die Herleitung Schritt für Schritt, die Lose, die Positionen, die Versionen', async () => {
  await wanda.getByRole('navigation', { name: 'Seiten der Wahl' }).getByRole('link', { name: 'Ergebnis und Herleitung' }).click()
  await expect(wanda).toHaveURL(`/wahlen/${electionId()}/ergebnis`)
  await expect(wanda.getByRole('heading', { level: 1, name: 'Ergebnis: Schulsprecherwahl 2026/27' })).toBeVisible()
  await expect(wanda.getByTestId('finalized')).toHaveText(/^Abgeschlossen am \d{1,2}\.\d{1,2}\.\d{4}, \d{2}:\d{2} durch Anna Lehrerin: Ergebnis festgestellt$/)

  const school = article(SCHOOL)
  const first = school.getByRole('region', { name: `Wahl: ${SCHOOL}`, exact: true })
  await expect(first.getByRole('columnheader')).toHaveText(['Kandidat:in', 'Erste Stellen', '6 Punkte · Schulsprecher/in', '5 Punkte · 1. Stellvertretung Schulsprecher/in', '4 Punkte · 2. Stellvertretung Schulsprecher/in', 'Punkte'])
  await expect(first.getByRole('row').filter({ hasText: 'Paula Berger' })).toHaveText(/Paula Berger\s*2\s*2\s*0\s*2\s*20/)
  await expect(first.getByRole('row').filter({ hasText: 'Quirin Huber-Mayer' })).toHaveText(/Quirin Huber-Mayer\s*1\s*1\s*2\s*1\s*20/)
  await expect(first.getByRole('row').filter({ hasText: 'Renate Wagner' })).toHaveText(/Renate Wagner\s*1\s*1\s*2\s*1\s*20/)
  await expect(first).toContainText('Gültige Stimmen: 4 · ungültig: 0 · Auszählung Version 2, Software dev (unknown)')
  const runoff = school.getByRole('region', { name: `Stichwahl: ${SCHOOL}`, exact: true })
  await expect(runoff.getByRole('columnheader')).toHaveText(['Kandidat:in', 'Erste Stellen', '1 Punkt · Stimme', 'Punkte'])
  await expect(runoff.getByRole('row').filter({ hasText: 'Renate Wagner' })).toHaveText(/Renate Wagner\s*2\s*2\s*2/)
  await expect(runoff.getByRole('row').filter({ hasText: 'Paula Berger' })).toHaveText(/Paula Berger\s*1\s*1\s*1/)

  await expect(school.getByRole('list', { name: `Herleitung: ${SCHOOL}` }).getByRole('listitem')).toHaveText([
    '4 Stimmen abgegeben, 4 gültig.',
    'Absolute Mehrheit: mindestens 3 erste Stellen nötig. Niemand erreicht sie.',
    'Vergleich nach ersten Stellen um 2 Plätze: Paula Berger 2, Quirin Huber-Mayer 1, Renate Wagner 1. Paula Berger kommt weiter, weil 2 > 1 erste Stellen. Gleichauf: Quirin Huber-Mayer und Renate Wagner.',
    'Vergleich nach Punkten der ersten Runde um 1 Platz: Quirin Huber-Mayer 20, Renate Wagner 20. Gleichauf: Quirin Huber-Mayer und Renate Wagner.',
    'Losentscheid: Quirin Huber-Mayer und Renate Wagner sind gleichauf; das Los entscheidet, wer von ihnen in die Stichwahl kommt (ein Platz). Bereits in der Stichwahl: Paula Berger.',
    'Los angewendet: Renate Wagner, Quirin Huber-Mayer.',
    'Stichwahl zwischen Paula Berger und Renate Wagner.',
    '3 Stimmen abgegeben, 3 gültig.',
    'Vergleich nach Stimmen um 1 Platz: Renate Wagner 2, Paula Berger 1. Renate Wagner kommt weiter, weil 2 > 1 Stimmen.',
    'Die weiteren Positionen nach den Punkten der ersten Runde, ohne Renate Wagner: Paula Berger 20, Quirin Huber-Mayer 20.',
    'Losentscheid: Paula Berger und Quirin Huber-Mayer sind gleichauf; das Los entscheidet die Reihenfolge für: 1. Stellvertretung Schulsprecher/in, 2. Stellvertretung Schulsprecher/in.',
    'Los angewendet: Quirin Huber-Mayer, Paula Berger.',
  ])
  await expect(school.getByRole('list', { name: `Losentscheide: ${SCHOOL}` }).getByRole('listitem')).toHaveCount(2)
  await expect(school.getByRole('list', { name: `Positionen: ${SCHOOL}` }).getByRole('listitem')).toHaveText([
    'Schulsprecher/in: Renate Wagner (Stichwahl)',
    '1. Stellvertretung Schulsprecher/in: Quirin Huber-Mayer (durch Los)',
    '2. Stellvertretung Schulsprecher/in: Paula Berger (durch Los)',
    '1. Stellvertretung im SGA: unbesetzt',
    '2. Stellvertretung im SGA: unbesetzt',
    '3. Stellvertretung im SGA: unbesetzt',
  ])

  const klass = article(CLASS_1A)
  await expect(klass.getByRole('region', { name: `Stichwahl: ${CLASS_1A}`, exact: true })).toHaveCount(0)
  await expect(klass.getByRole('list', { name: `Herleitung: ${CLASS_1A}` }).getByRole('listitem')).toHaveText([
    '4 Stimmen abgegeben, 4 gültig.',
    'Absolute Mehrheit: mindestens 3 erste Stellen nötig. Max Fuchs erreicht sie.',
    'Die weiteren Positionen nach den Punkten der ersten Runde, ohne Max Fuchs: Lena Bauer 5.',
  ])
  await expect(klass).toContainText('Gewählt.')
  await shot(wanda, '35-ergebnis-herleitung')
})

test('das Protokoll: die Kette ist vollständig, jeder Eintrag ein Satz mit Person und Zeit, vom Anlegen bis zum Export', async () => {
  await wanda.getByRole('link', { name: 'Protokoll' }).click()
  await expect(wanda).toHaveURL(`/wahlen/${electionId()}/protokoll`)
  await expect(wanda.getByRole('heading', { level: 1, name: 'Protokoll: Schulsprecherwahl 2026/27' })).toBeVisible()
  const { body: audit } = await apiGet<{ events: unknown[], chain: { valid: boolean, length: number, head: string | null } }>(wanda, `/api/elections/${electionId()}/audit`)
  await expect(wanda.getByTestId('chain')).toContainText(`Die Protokollkette hält zusammen: ${audit.chain.length} Einträge, jeder mit der Prüfsumme des vorigen; kein Eintrag wurde verändert. Letzte Prüfsumme: ${audit.chain.head}.`)
  const entries = wanda.getByRole('list', { name: 'Protokoll' }).getByRole('listitem')
  await expect(entries).toHaveCount(audit.events.length)
  await expect(entries.first()).toContainText('Anna Lehrerin')
  await expect(entries.first()).toContainText('Wahl „Schulsprecherwahl 2026/27“ angelegt.')
  await expect(entries.last()).toContainText(/Export erzeugt: \d+ Bytes, SHA-256 [0-9a-f]{64}\./)
  await expect(entries.filter({ hasText: 'Losentscheid für „Schulsprecher/in“ eingetragen: Renate Wagner, Quirin Huber-Mayer. Begründung: Los gezogen von der Wahlkommission am 5. Oktober' })).toHaveCount(1)
  await expect(entries.filter({ hasText: 'Wahl abgeschlossen: 2 entschieden, 0 offen. Begründung: Ergebnis festgestellt' })).toHaveCount(1)
  await expect(entries.filter({ hasText: 'Stapel für „1A“ (Wahl) ersetzt: 25 neue Stimmkarten, die alten ungültig.' })).toHaveCount(1)
  await expect(entries.filter({ hasText: 'wanda.zeugin@schule.example.org hat sich angemeldet (Zeugin/Zeuge).' })).toHaveCount(1)
  // The runoff's count found the deputies tied: the outcome at that close still needed a lot.
  await expect(entries.filter({ hasText: /Ergebnis ausgezählt: „Schulsprecher\/in“, Stichwahl, 3 Stimmen: Losentscheid erforderlich\. Prüfsumme der Auszählung: [0-9a-f]{64}\./ })).toHaveCount(1)
  await expect(entries.filter({ hasText: /Ergebnis ausgezählt: „Klassensprecher\/in 1A“, Wahl, 4 Stimmen: entschieden\./ })).toHaveCount(1)
  await shot(wanda, '36-protokoll')
})

test('die Hilfe zum Wahltag, über den Link der Wahl', async () => {
  await wanda.getByRole('link', { name: 'Zur Wahl' }).click()
  await wanda.getByRole('navigation', { name: 'Seiten der Wahl' }).getByRole('link', { name: 'Ablauf am Wahltag' }).click()
  await expect(wanda).toHaveURL('/hilfe/wahltag')
  await expect(wanda.getByRole('heading', { level: 1, name: 'Ablauf am Wahltag' })).toBeVisible()
  await expect(wanda.getByRole('heading', { level: 2 })).toHaveText(['Vor dem Wahltag', 'Am Wahltag', 'Zwischenfälle', 'Was Zeug:innen sehen'])
  await expect(wanda.getByText('Die Wahl wurde zu früh geschlossen')).toBeVisible()
  await shot(wanda, '37-hilfe')
})
