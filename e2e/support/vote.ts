// Voting on a phone as a student does, for the specs that need ballots
// cast and not the ballot page itself (09 covers that): the card's code
// in the fragment, one complete ballot per contest given, filled by the
// candidates' names in the order of the rows, checked and cast; the
// session ends with the last ballot.

import { expect, type BrowserContext, type Page } from '@playwright/test'
import { inOrder } from '../../apps/api/lib/in-order.ts'

export interface Ballot {
  /** The contest's title, as the list of contests names it. */
  contest: string
  /** The candidates' names in the order of the ballot's rows: one for a runoff or a poll. */
  ranking: readonly string[]
}

export async function voteOnPhone(context: BrowserContext, key: string, ballots: readonly Ballot[]): Promise<void> {
  const page = await context.newPage()
  await page.goto(`/v#${key}`)
  await expect(page.getByRole('list', { name: 'Wahlgänge' })).toBeVisible()
  await inOrder(ballots, (ballot) => castOne(page, ballot))
  await expect(page.getByRole('heading', { name: 'Danke!' })).toBeVisible()
  await page.close()
}

/** One ballot: the contest's button, the rows filled in order, checked and cast. */
async function castOne(page: Page, ballot: Ballot): Promise<void> {
  await page.getByRole('button', { name: `Stimmzettel ausfüllen: ${ballot.contest}` }).click()
  const rows = page.getByRole('combobox')
  await expect(rows).toHaveCount(ballot.ranking.length)
  await inOrder(ballot.ranking.entries(), ([index, name]) => rows.nth(index).selectOption({ label: name }))
  await page.getByRole('button', { name: 'Prüfen' }).click()
  await expect(page.getByRole('status')).toHaveText('Gültige Stimme.')
  await page.getByRole('button', { name: 'Abgeben', exact: true }).click()
}
