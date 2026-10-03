// Stimmkarten: je Klasse erzeugen, drucken, noch einmal drucken, und ein
// Stapel ersetzen. Was auf der Karte steht, ist, was die API speichert:
// der QR-Code der ersten Karte ergibt den ersten gespeicherten Code.

import { expect, test, type Locator, type Page } from '@playwright/test'
import { apiGet } from '../support/api.ts'
import { electionId, journey, remember } from '../support/journey.ts'
import { ANNA, WANDA } from '../support/personas.ts'
import { decodeQr } from '../support/qr.ts'
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

const sheets = () => page.getByRole('region', { name: 'Stimmkarten' })
const classBox = (name: string) => sheets().locator('.card-box').filter({ has: page.getByRole('heading', { name, exact: true }) })

async function issue(name: string, count: number, button: string): Promise<string> {
  await classBox(name).getByLabel('Anzahl Wählende').fill(String(count))
  await classBox(name).getByRole('button', { name: button, exact: true }).click()
  await expect(sheets().getByRole('status')).toContainText(`${count} Stimmkarten`)
  const href = await sheets().getByRole('link', { name: 'Jetzt drucken' }).getAttribute('href')
  const id = href?.match(/\/batches\/([0-9a-f-]{36})\/print$/)?.[1]
  expect(id).toBeTruthy()
  return id ?? ''
}

async function keysOf(batch: string): Promise<string[]> {
  const { body } = await apiGet<{ keys: { key: string }[] }>(page, `/api/elections/${electionId()}/batches/${batch}`)
  return body.keys.map((entry) => entry.key)
}

async function printPageOf(link: Locator): Promise<Page> {
  const [opened] = await Promise.all([page.context().waitForEvent('page'), link.click()])
  await opened.waitForLoadState()
  return opened
}

test('je Klasse ein Stapel, und für die 1A auch Stichwahl-Stimmkarten', async () => {
  const regular1A = await issue('1A', 25, 'Stimmkarten erzeugen')
  const regular2B = await issue('2B', 20, 'Stimmkarten erzeugen')
  const runoff1A = await issue('1A', 10, 'Stichwahl-Stimmkarten erzeugen')
  await expect(classBox('1A').getByTestId('batch-regular-issued')).toContainText('25')
  await expect(classBox('1A').getByTestId('batch-runoff-issued')).toContainText('10')
  await expect(classBox('2B').getByTestId('batch-regular-issued')).toContainText('20')
  remember({ batches: { '1A regular': regular1A, '2B regular': regular2B, '1A runoff': runoff1A } })
  await shot(page, '10-stimmkarten')
})

test('die Druckseite: sechs Karten je Seite, und der QR-Code der ersten Karte ist der erste gespeicherte Code', async () => {
  const batch = journeyBatch('1A regular')
  const printed = await printPageOf(classBox('1A').getByTestId('batch-regular-issued').getByRole('link', { name: 'Drucken' }))
  await expect(printed.getByTestId('page')).toHaveCount(5)
  await expect(printed.getByTestId('card')).toHaveCount(25)
  await expect(printed.getByRole('button', { name: 'Drucken' })).toBeVisible()
  const first = printed.getByTestId('card').first()
  await expect(first).toContainText('Schulsprecherwahl 2026/27')
  await expect(first).toContainText('Wahl · 1A')
  const shownKey = ((await first.getByTestId('key').textContent()) ?? '').replaceAll('-', '')
  expect(shownKey).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/)
  const qr = await first.getByTestId('qr').getAttribute('src')
  expect(decodeQr(qr ?? '')).toBe(`${new URL(page.url()).origin}/v#${shownKey}`)
  const stored = await keysOf(batch)
  expect(stored).toHaveLength(25)
  expect(stored[0]).toBe(shownKey)
  await shot(printed, '11-druckseite')

  // Opening the page again shows the same codes: nothing is created.
  await printed.reload()
  await expect(printed.getByTestId('card')).toHaveCount(25)
  expect(((await printed.getByTestId('key').first().textContent()) ?? '').replaceAll('-', '')).toBe(shownKey)
  expect(await keysOf(batch)).toEqual(stored)
  await printed.close()
  remember({ firstKey: shownKey })
})

test('eine Zeugin sieht die Anzahl, aber keinen Code, solange die Runde nicht geschlossen ist', async ({ browser }) => {
  const wanda = await (await browser.newContext()).newPage()
  await openAs(wanda, WANDA, `/wahlen/${electionId()}`)
  const region = wanda.getByRole('region', { name: 'Stimmkarten' })
  await expect(region.getByTestId('batch-regular-issued').first()).toContainText('25')
  await expect(region.getByRole('link')).toHaveCount(0)
  const refused = await apiGet(wanda, `/api/elections/${electionId()}/batches/${journeyBatch('1A regular')}`)
  expect(refused.status).toBe(403)
  await wanda.context().close()
})

test('einen Stapel ersetzen: die alten Codes gelten nicht mehr, bleiben aber zum Vergleich', async () => {
  const old = journeyBatch('1A regular')
  const oldKeys = await keysOf(old)
  await sheets().getByRole('button', { name: 'Stapel ersetzen: 1A, Wahl' }).click()
  const dialog = sheets().getByRole('alertdialog', { name: 'Stapel ersetzen?' })
  await expect(dialog).toContainText('Die 25 bisherigen Stimmkarten für 1A (Wahl) werden ungültig.')
  await shot(page, '12-stapel-ersetzen')
  await dialog.getByRole('button', { name: 'Ja, Stapel ersetzen' }).click()
  await expect(sheets().getByRole('status')).toContainText('Der Stapel wurde ersetzt: 25 neue Stimmkarten.')
  await expect(classBox('1A').getByTestId('batch-regular-void')).toContainText('ungültig')
  await expect(classBox('1A').getByTestId('batch-regular-issued')).toContainText('25')

  const replacement = (await sheets().getByRole('link', { name: 'Jetzt drucken' }).getAttribute('href'))?.match(/\/batches\/([0-9a-f-]{36})\/print$/)?.[1] ?? ''
  expect(replacement).not.toBe(old)
  const newKeys = await keysOf(replacement)
  expect(newKeys).toHaveLength(25)
  expect(newKeys.filter((key) => oldKeys.includes(key))).toEqual([])
  remember({ batches: { ...journeyBatches(), '1A regular': replacement, '1A replaced': old } })

  // The replaced batch's page lists its codes and prints nothing.
  const codes = await printPageOf(classBox('1A').getByTestId('batch-regular-void').getByRole('link', { name: 'Codes anzeigen' }))
  await expect(codes.getByText('Dieser Stapel gilt nicht mehr')).toBeVisible()
  await expect(codes.getByTestId('usage')).toHaveCount(25)
  await expect(codes.getByTestId('card')).toHaveCount(0)
  await expect(codes.getByRole('button', { name: 'Drucken' })).toHaveCount(0)
  await codes.close()
})

function journeyBatches(): Record<string, string> {
  return journey().batches ?? {}
}

function journeyBatch(name: string): string {
  const id = journeyBatches()[name]
  if (!id) throw new Error(`no batch "${name}" yet: the specs build on each other`)
  return id
}
