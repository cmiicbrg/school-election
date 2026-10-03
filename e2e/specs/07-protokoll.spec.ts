// Das Protokoll: alles, was die Journey getan hat, steht in der
// Protokollkette der Wahl, und die Kette stimmt.

import { expect, test } from '@playwright/test'
import { apiGet } from '../support/api.ts'
import { electionId } from '../support/journey.ts'
import { ANNA } from '../support/personas.ts'
import { openAs } from '../support/sign-in.ts'

test('die Protokollkette stimmt und zählt genau die Schritte der Journey', async ({ page }) => {
  await openAs(page, ANNA, `/wahlen/${electionId()}`)
  const { body: audit } = await apiGet<{
    events: { action: string, actor: { name: string } }[]
    chain: { valid: boolean, length: number }
  }>(page, `/api/elections/${electionId()}/audit`)
  expect(audit.chain.valid).toBe(true)
  expect(audit.chain.length).toBe(audit.events.length)
  const counts = new Map<string, number>()
  for (const event of audit.events) counts.set(event.action, (counts.get(event.action) ?? 0) + 1)
  expect(Object.fromEntries([...counts].toSorted())).toEqual({
    'candidate.added': 5,
    'candidate.picture-set': 1,
    'candidate.renamed': 1,
    'contest.created': 2,
    'credential-batch.issued': 3,
    'credential-batch.replaced': 1,
    'credential-batch.voided': 1,
    'election.created': 1,
    'election.prepared': 3,
    'election.unprepared': 2,
    'member.bound': 2,
    'member.invited': 2,
    'voter-group.contest-added': 4,
    'voter-group.created': 2,
  })
  expect(audit.events[0]?.action).toBe('election.created')
  expect(audit.events.at(-1)?.action).toBe('election.prepared')
  const actors = new Set(audit.events.map((event) => event.actor.name))
  expect([...actors].toSorted()).toEqual(['Anna Lehrerin', 'Carla Kollegin', 'Wanda Zeugin'])
})
