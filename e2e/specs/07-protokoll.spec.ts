// Das Protokoll: alles, was die Journey getan hat, steht in der
// Protokollkette der Wahl, und die Kette stimmt; die Seite zeigt genau
// diese Einträge. Und vor dem Schließen gibt es kein Ergebnis zu lesen.

import { expect, test } from '../support/test.ts'
import { apiGet } from '../support/api.ts'
import { electionId } from '../support/journey.ts'
import { ANNA } from '../support/personas.ts'
import { shot } from '../support/screenshot.ts'
import { at } from '../support/base.ts'
import { openAs } from '../support/sign-in.ts'

test('die Protokollkette stimmt und zählt genau die Schritte der Journey', async ({ page }) => {
  await openAs(page, ANNA, `/wahlen/${electionId()}`)
  const { body: audit } = await apiGet<{
    events: { action: string, actor: { name: string } }[]
    chain: { valid: boolean, length: number, head: string | null }
  }>(page, `/api/elections/${electionId()}/audit`)
  expect(audit.chain).toEqual({ valid: true, length: audit.events.length, head: expect.any(String) })
  const counts = new Map<string, number>()
  for (const event of audit.events) counts.set(event.action, (counts.get(event.action) ?? 0) + 1)
  expect(Object.fromEntries([...counts].toSorted())).toEqual({
    'candidate.added': 6,
    'candidate.picture-set': 2,
    'candidate.renamed': 3,
    'contest.created': 3,
    'contest.removed': 1,
    'credential-batch.issued': 4,
    'credential-batch.replaced': 1,
    'credential-batch.voided': 2,
    'election.created': 1,
    'election.prepared': 3,
    'election.unprepared': 2,
    'election.updated': 1,
    'lead.transferred': 2,
    'member.bound': 2,
    'member.invited': 2,
    'voter-group.contest-added': 4,
    'voter-group.created': 2,
  })
  expect(audit.events[0]?.action).toBe('election.created')
  expect(audit.events.at(-1)?.action).toBe('election.prepared')
  const actors = new Set(audit.events.map((event) => event.actor.name))
  expect([...actors].toSorted()).toEqual(['Anna Lehrerin', 'Carla Kollegin', 'Wanda Zeugin'])

  // The page shows the same entries, in order, as sentences.
  await page.getByRole('navigation', { name: 'Seiten des Wahltermins' }).getByRole('link', { name: 'Protokoll' }).click()
  await expect(page).toHaveTitle('Protokoll: Schulsprecherwahl 2026/27 – Schulwahl')
  await expect(page.getByTestId('chain')).toContainText(`Die Protokollkette ist in sich schlüssig: ${audit.events.length} Einträge, jeder mit der Prüfsumme des vorigen. Letzte Prüfsumme: ${audit.chain.head}.`)
  const entries = page.getByRole('list', { name: 'Protokoll' }).getByRole('listitem')
  await expect(entries).toHaveCount(audit.events.length)
  await expect(entries.first()).toContainText('Wahltermin „Schulsprecherwahl 2026/27“ angelegt.')
  await expect(entries.last()).toContainText('Wahltermin vorbereitet: 2 Wahlen, 2 Klassen oder Gruppen, 5 Kandidat:innen.')
  await expect(entries.filter({ hasText: 'Paula Berger zu „Schulsprecher/in“ hinzugefügt.' })).toHaveCount(1)
  await expect(entries.filter({ hasText: 'Wahl „Klassensprecher/in 1A“ angelegt: Vertretung und Stellvertretung: zwei Reihungen, 2 und 1 Punkt.' })).toHaveCount(1)
  await shot(page, '07a-protokoll-vorbereitet')
})

test('vor dem Schließen gibt es kein Ergebnis zu lesen, und die Wahl verlinkt es noch nicht', async ({ page }) => {
  await openAs(page, ANNA, `/wahlen/${electionId()}`)
  await expect(page.getByRole('navigation', { name: 'Seiten des Wahltermins' }).getByRole('link', { name: 'Ergebnis und Herleitung' })).toHaveCount(0)
  await page.goto(at(`/wahlen/${electionId()}/ergebnis`))
  await expect(page.getByTestId('early')).toHaveText('Das Ergebnis gibt es, sobald der 1. Wahlgang beendet und ausgezählt ist. Solange ein Wahlgang läuft, sieht niemand Zwischenstände.')
})
