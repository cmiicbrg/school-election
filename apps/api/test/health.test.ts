// The health check's busy flag: true while any round of any election
// accepts ballots (open, or in test mode), so the deployment's nightly
// update stays away from a running vote; false otherwise.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DB } from './helpers/db.ts'
import { ANNA, createElection, electionApp, forceElectionState, forceRoundState, signIn } from './helpers/elections.ts'

test('the health check is busy while a round accepts ballots, and not otherwise', DB, async (t) => {
  const s = await electionApp(t)
  const busy = async () => {
    const { status, busy: flag } = (await s.app.inject({ method: 'GET', url: '/api/health' })).json<{ status: string, busy: boolean }>()
    return { status, busy: flag }
  }
  assert.deepEqual(await busy(), { status: 'ok', busy: false }, 'no election')
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  await forceElectionState(s.ownerUrl, id, 'prepared')
  assert.equal((await busy()).busy, false, 'planned')
  await forceRoundState(s.ownerUrl, id, 'testing')
  assert.equal((await busy()).busy, true, 'a test accepts ballots')
  await forceRoundState(s.ownerUrl, id, 'planned')
  assert.equal((await busy()).busy, false, 'the test ended')
  await forceElectionState(s.ownerUrl, id, 'active')
  assert.equal((await busy()).busy, true, 'open')
  await forceRoundState(s.ownerUrl, id, 'closed')
  assert.equal((await busy()).busy, false, 'closed')
})
