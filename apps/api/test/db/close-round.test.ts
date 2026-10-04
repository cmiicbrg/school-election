// closeRound as the close route will call it: the lifecycle's say before
// and after, the seal, the audit event with the count, who may close, and
// a close racing the votes still coming in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { lockElection, readAuditChain } from '../../lib/audit.ts'
import { verifyAuditChain } from '../../lib/audit-chain.ts'
import type { ElectionAccess } from '../../lib/election-access.ts'
import { closeRound } from '../../lib/rounds.ts'
import { DB, withClient } from '../helpers/db.ts'
import { as, cast, ELECTION, openDirectly as open, refusedWith, ROUND, setup, type Setup } from '../helpers/representative-election.ts'

/** closeRound as the route runs it: in a transaction, holding the election's lock. */
const close = (s: Setup, access: ElectionAccess, kind: 'regular' | 'runoff' = 'regular') => s.db.tx(async (client) => {
  await lockElection(client, ELECTION)
  return closeRound(client, access, kind)
})

test('a round closes once it is open, with its audit event, and the lifecycle refuses it before and afterwards', DB, async (t) => {
  const s = await setup(t)
  await assert.rejects(close(s, await as(s)), refusedWith(409, 'round_planned'))
  await open(s.ownerUrl)
  const stale = await as(s)
  assert.deepEqual(await cast(s, s.credentialIds[0] ?? ''), { cast: true })
  assert.deepEqual(await cast(s, s.credentialIds[1] ?? ''), { cast: true })

  assert.deepEqual(await close(s, stale), { roundId: ROUND, ballots: 2 })
  await withClient(s.ownerUrl, async (client) => {
    assert.equal((await client.query<{ state: string }>('select state from round where id = $1', [ROUND])).rows[0]?.state, 'closed')
    const chain = await readAuditChain(client, ELECTION)
    assert.equal(verifyAuditChain(chain).valid, true)
    assert.deepEqual(chain.map((event) => [event.action, event.metadata]), [['round.closed', { round: 'regular', ballots: 2 }]])
  })
  // Closed: the lifecycle refuses; and a caller still holding the old lifecycle is refused by the seal.
  await assert.rejects(close(s, await as(s)), refusedWith(409, 'round_closed'))
  await assert.rejects(close(s, stale), refusedWith(409, 'round_closed'))
  assert.equal((await withClient(s.ownerUrl, (client) => client.query('select 1 from audit_event'))).rowCount, 1)
})

test('closing is for the owner and co-admins, and a runoff that was never activated cannot close', DB, async (t) => {
  const s = await setup(t)
  await open(s.ownerUrl)
  await assert.rejects(close(s, await as(s, 'witness')), refusedWith(403, 'forbidden'))
  await assert.rejects(close(s, await as(s, 'admin'), 'runoff'), refusedWith(409, 'no_runoff'))
  assert.deepEqual(await close(s, await as(s, 'admin')), { roundId: ROUND, ballots: 0 })
})

test('a close racing the votes still coming in seals every ballot that got in, refuses the rest, and leaves nothing staged', DB, async (t) => {
  const s = await setup(t, 30)
  await open(s.ownerUrl)
  const access = await as(s)
  const votes = s.credentialIds.map((credentialId) => cast(s, credentialId))
  const closing = sleep(5).then(() => close(s, access))
  const results = await Promise.all(votes)
  const { ballots } = await closing
  const cast_ = results.filter((result) => result.cast).length
  const refused = results.filter((result) => !result.cast && result.reason === 'refused').length
  assert.equal(cast_ + refused, 30, 'every vote was either cast or refused')
  assert.equal(ballots, cast_, 'every ballot that got in was sealed')
  const { rows: [counts] } = await withClient(s.ownerUrl, (client) => client.query<{ staged: number, sealed: number, used: number }>(
    `select (select count(*)::int from ballot_box) as staged, (select count(*)::int from ballot) as sealed,
            (select count(*)::int from credential_entitlement where consumed) as used`,
  ))
  assert.deepEqual(counts, { staged: 0, sealed: cast_, used: cast_ })
})
