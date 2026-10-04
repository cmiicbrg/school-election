// The runoff round at the database: activate_runoff creates it open with
// its boxes and the entitlements of the issued runoff batches, once, after
// the regular round closed, and in no other way; a runoff ballot names the
// pair alone; keys of the first round and of a void batch never vote in it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateBallot } from '@school-election/election-core'
import { castBallot } from '../../lib/ballot-box.ts'
import { issueBatch } from '../../lib/credentials.ts'
import { SQLSTATE, sqlState } from '../../lib/pg-errors.ts'
import { DB, withClient } from '../helpers/db.ts'
import { activateDirectly, as, BOX, cast, CONTEST, ELECTION, GROUP, issueRunoffBatch, openDirectly, PAULA, QUIRIN, refusedWith, RUNOFF_BATCH, RUNOFF_OF, sealDirectly, setup, type Setup } from '../helpers/representative-election.ts'

const refusedBy = (err: unknown): boolean => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState

/** The first round voted and sealed: what a runoff follows. */
async function closedFirstRound(s: Setup): Promise<void> {
  await openDirectly(s.ownerUrl)
  assert.deepEqual(await cast(s, s.credentialIds[0] ?? ''), { cast: true })
  await sealDirectly(s)
}

async function runoffBox(s: Setup, roundId: string): Promise<{ id: string, runoff_pair: string[] }> {
  const { rows: [box] } = await withClient(s.ownerUrl, (client) => client.query<{ id: string, runoff_pair: string[] }>(
    'select id, runoff_pair from round_contest where round_id = $1', [roundId],
  ))
  return box ?? assert.fail('no runoff box')
}

test('activate_runoff creates the round open with a box per pair and the entitlements of the issued runoff batches, and nothing for a void batch or a first-round key', DB, async (t) => {
  const s = await setup(t)
  await closedFirstRound(s)
  const fresh = await issueRunoffBatch(s.ownerUrl, 2)
  const voided = await issueRunoffBatch(s.ownerUrl, 2, 'c2b3a507-e3d6-47f8-8ea3-9fa0b1c2d3e5')
  await withClient(s.ownerUrl, (client) => client.query(`update credential_batch set state = 'void' where id = 'c2b3a507-e3d6-47f8-8ea3-9fa0b1c2d3e5'`))

  const roundId = await activateDirectly(s)
  await withClient(s.ownerUrl, async (client) => {
    const { rows: [round] } = await client.query<{ kind: string, state: string, phase: string | null }>('select kind, state, phase from round where id = $1', [roundId])
    assert.deepEqual([round?.kind, round?.state, typeof round?.phase], ['runoff', 'open', 'string'])
    const box = await runoffBox(s, roundId)
    assert.deepEqual(box.runoff_pair, [PAULA, QUIRIN])
    const { rows: entitled } = await client.query<{ credential_id: string }>('select credential_id from credential_entitlement where round_contest_id = $1 order by credential_id', [box.id])
    assert.deepEqual(entitled.map((row) => row.credential_id), [...fresh].sort(), 'the issued runoff keys, and only those')
    for (const id of [...voided, ...s.credentialIds]) assert.ok(!entitled.some((row) => row.credential_id === id))
  })
  // Keys of the first round and of the void batch have no entitlement in the runoff; the fresh ones vote once.
  const box = await runoffBox(s, roundId)
  const runoffVote = (credentialId: string, candidate = QUIRIN) => s.db.tx((client) => {
    const ballot = validateBallot(RUNOFF_OF, { kind: 'ranking', ranking: [candidate] })
    assert.ok(ballot.ok)
    return castBallot(client, { credentialId, roundContestId: box.id, contest: RUNOFF_OF, ballot: ballot.ballot })
  })
  assert.deepEqual(await runoffVote(fresh[0] ?? ''), { cast: true })
  assert.deepEqual(await runoffVote(fresh[0] ?? ''), { cast: false, reason: 'already-voted' })
  assert.deepEqual(await runoffVote(voided[0] ?? ''), { cast: false, reason: 'not-entitled' })
  assert.deepEqual(await runoffVote(s.credentialIds[1] ?? ''), { cast: false, reason: 'not-entitled' })
  const { rows: [staged] } = await withClient(s.ownerUrl, (client) => client.query<{ n: number }>('select count(*)::int as n from ballot_box where round_contest_id = $1', [box.id]))
  assert.equal(staged?.n, 1)
})

test('a runoff round comes to be in no other way, once, after the regular round closed, of contests of the regular round and pairs of their candidates', DB, async (t) => {
  const s = await setup(t)
  await assert.rejects(activateDirectly(s), refusedBy, 'prepared: the regular round has not opened')
  await openDirectly(s.ownerUrl)
  await assert.rejects(activateDirectly(s), refusedBy, 'open: not closed yet')
  await sealDirectly(s)
  // By hand, planned or open, as the owner or the runtime role: never.
  for (const state of ['planned', 'open']) {
    await withClient(s.ownerUrl, (client) => assert.rejects(client.query(`insert into round (election_id, kind, state) values ($1, 'runoff', $2)`, [ELECTION, state]), refusedBy, `owner ${state}`))
    await assert.rejects(s.db.query(`insert into round (election_id, kind, state) values ($1, 'runoff', $2)`, [ELECTION, state]), refusedBy, `runtime ${state}`)
  }
  await assert.rejects(activateDirectly(s, []), refusedBy, 'no pairs')
  await assert.rejects(activateDirectly(s, [{ contestId: '00000000-0000-4000-8000-000000000000', candidates: [PAULA, QUIRIN] }]), refusedBy, 'not a contest of the regular round')
  await assert.rejects(activateDirectly(s, [{ contestId: CONTEST, candidates: [PAULA, '00000000-0000-4000-8000-000000000001'] }]), refusedBy, 'not two candidates of the contest')
  await assert.rejects(activateDirectly(s, [{ contestId: CONTEST, candidates: [PAULA, PAULA] }]), refusedBy, 'the same candidate twice')
  await assert.rejects(activateDirectly(s, [{ contestId: CONTEST, candidates: [PAULA, QUIRIN] }, { contestId: CONTEST, candidates: [QUIRIN, PAULA] }]), (err: unknown) => sqlState(err) === '23505', 'a contest twice')
  const { rows: [none] } = await withClient(s.ownerUrl, (client) => client.query<{ n: number }>(`select count(*)::int as n from round where kind = 'runoff'`))
  assert.equal(none?.n, 0, 'every refusal left nothing behind')

  const roundId = await activateDirectly(s)
  await assert.rejects(activateDirectly(s), refusedBy, 'a second time')
  // A box added to the open runoff by hand, or the box's pair changed: refused for everyone.
  await withClient(s.ownerUrl, async (client) => {
    await assert.rejects(client.query('insert into round_contest (election_id, round_id, contest_id, runoff_pair) values ($1, $2, $3, $4)', [ELECTION, roundId, CONTEST, [PAULA, QUIRIN]]), refusedBy)
    await assert.rejects(client.query('update round_contest set runoff_pair = $2 where round_id = $1', [roundId, [QUIRIN, PAULA]]), refusedBy)
  })
})

test('a runoff ballot names the pair alone, never "Nein", and the seal and the count take it like any other', DB, async (t) => {
  const s = await setup(t)
  // A third candidate, while candidates can still change, who will not be in the pair.
  const RENATE = 'e4d537c9-05f8-4910-8ac5-b1c2d3e4f5a6'
  await withClient(s.ownerUrl, (client) => client.query(`insert into candidate (id, election_id, contest_id, surname, given_name) values ('${RENATE}', '${ELECTION}', '${CONTEST}', 'Wagner', 'Renate')`))
  await closedFirstRound(s)
  const [key] = await issueRunoffBatch(s.ownerUrl, 1)
  const roundId = await activateDirectly(s)
  const box = await runoffBox(s, roundId)
  const staged = (kind: string, ranking: string[]) => s.db.tx(async (client) => {
    await client.query('update credential_entitlement set consumed = true where credential_id = $1 and round_contest_id = $2', [key, box.id])
    await client.query('insert into ballot_box (election_id, round_contest_id, kind, ranking) values ($1, $2, $3, $4::uuid[])', [ELECTION, box.id, kind, ranking])
  })
  await assert.rejects(staged('ranking', [RENATE]), refusedBy, 'a candidate of the contest outside the pair')
  await assert.rejects(staged('ranking', [PAULA, QUIRIN]), refusedBy, 'both of the pair at once is more than the one choice')
  await assert.rejects(staged('invalid', [PAULA]), refusedBy, 'an invalid vote names nobody')
  await assert.rejects(staged('no', []), refusedBy, '"Nein" has no place in a runoff')
  await staged('ranking', [PAULA])
  await s.db.query('select seal_round($1)', [roundId])
  const { rows: [sealed] } = await withClient(s.ownerUrl, (client) => client.query<{ n: number }>('select count(*)::int as n from ballot where round_contest_id = $1', [box.id]))
  assert.equal(sealed?.n, 1)
})

test('runoff batches are issued until the activation, by the lifecycle and by the database; a batch issued after the first round closed is entitled', DB, async (t) => {
  const s = await setup(t)
  const before = await issueRunoffBatch(s.ownerUrl, 1)
  await closedFirstRound(s)
  const after = await issueRunoffBatch(s.ownerUrl, 1, 'd3c4b618-f4e7-4809-9fb4-a0b1c2d3e4f6')
  const roundId = await activateDirectly(s)
  const box = await runoffBox(s, roundId)
  const { rows: entitled } = await withClient(s.ownerUrl, (client) => client.query<{ credential_id: string }>('select credential_id from credential_entitlement where round_contest_id = $1 order by credential_id', [box.id]))
  assert.deepEqual(entitled.map((row) => row.credential_id), [...before, ...after].sort())
  // From now on: the lifecycle refuses issuing (the runoff's voting has started), and so does the batch window, for the owner too.
  await assert.rejects(
    s.db.tx(async (client) => issueBatch(client, await as(s), { voterGroupId: GROUP, roundKind: 'runoff', count: 1 })),
    refusedWith(409, 'voting_started'),
  )
  await withClient(s.ownerUrl, (client) => assert.rejects(
    client.query(`insert into credential_batch (election_id, voter_group_id, round_kind) values ('${ELECTION}', '${GROUP}', 'runoff')`), refusedBy,
  ))
  assert.equal(RUNOFF_BATCH.length, 36)
  assert.equal(BOX.length, 36)
})
