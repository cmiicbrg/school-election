// Opening and closing with the count, as the round routes call them: the
// lifecycle's say, the database's steps in order, the snapshot a close
// writes and what it holds, a close that cannot count, turnout, and that a
// snapshot never changes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lockElection, readAuditChain } from '../../lib/audit.ts'
import type { ElectionAccess } from '../../lib/election-access.ts'
import type { ElectionRole } from '../../lib/permissions.ts'
import { SQLSTATE, sqlState } from '../../lib/pg-errors.ts'
import { closeAndTally, openRound, readTurnout } from '../../lib/rounds.ts'
import { ballotsOf, inputDigest, readResults, tallyContest, TallyError } from '../../lib/tally.ts'
import { DB, withClient } from '../helpers/db.ts'
import { as, BOX, cast, CONTEST, CONTEST_OF, ELECTION, PAULA, QUIRIN, ranking, refusedWith, ROUND, setup, type Setup } from '../helpers/representative-election.ts'

const BUILD = { version: 'v9.9.9', gitSha: 'abcdef0' }

/** As the routes run them: in a transaction, holding the election's lock. */
const open = (s: Setup, access: ElectionAccess) => s.db.tx(async (client) => {
  await lockElection(client, ELECTION)
  return openRound(client, access)
})
const close = (s: Setup, access: ElectionAccess) => s.db.tx(async (client) => {
  await lockElection(client, ELECTION)
  return closeAndTally(client, access, BUILD)
})

async function states(s: Setup): Promise<{ election: string, round: string }> {
  return withClient(s.ownerUrl, async (client) => (await client.query<{ election: string, round: string }>(
    `select e.state as election, r.state as round from election e join round r on r.election_id = e.id where e.id = '${ELECTION}'`,
  )).rows[0]!)
}

test('opening moves the election to active and the round to open, once, for those who run rounds', DB, async (t) => {
  const s = await setup(t)
  await assert.rejects(open(s, await as(s, 'witness')), refusedWith(403, 'forbidden'))
  await open(s, await as(s))
  assert.deepEqual(await states(s), { election: 'active', round: 'open' })
  await assert.rejects(open(s, await as(s)), refusedWith(409, 'voting_started'))
  const actions = await withClient(s.ownerUrl, async (client) => (await readAuditChain(client, ELECTION)).map((event) => event.action))
  assert.deepEqual(actions, ['round.opened'])
})

test('the database lets a round open only once its election is active, so the election goes first', DB, async (t) => {
  const s = await setup(t)
  await assert.rejects(s.db.query(`update round set state = 'open' where id = '${ROUND}'`), (err) => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState)
  assert.deepEqual(await states(s), { election: 'prepared', round: 'planned' })
})

test('closing seals and counts in one transaction: a snapshot per box, reproducible from the sealed ballots', DB, async (t) => {
  const s = await setup(t)
  await assert.rejects(close(s, await as(s)), refusedWith(409, 'round_planned'))
  await open(s, await as(s))
  const [first, second, third] = s.credentialIds as [string, string, string]
  assert.deepEqual(await cast(s, first), { cast: true })
  assert.deepEqual(await cast(s, second, ranking([QUIRIN, PAULA])), { cast: true })

  await assert.rejects(close(s, await as(s, 'witness')), refusedWith(403, 'forbidden'))
  const closed = await close(s, await as(s))
  // Two ballots, each candidate first on one: both fill the two runoff places, so no lot.
  assert.deepEqual(closed, { ballots: 2, contests: [{ contestId: CONTEST, outcome: 'runoff-required' }] })
  assert.deepEqual(await states(s), { election: 'active', round: 'closed' })
  await assert.rejects(close(s, await as(s)), refusedWith(409, 'round_closed'))
  assert.deepEqual(await cast(s, third), { cast: false, reason: 'refused' })

  const results = await s.db.tx((client) => readResults(client, ELECTION, ROUND))
  assert.equal(results.length, 1)
  const stored = results[0]!
  assert.equal(stored.contestId, CONTEST)
  assert.deepEqual({ version: stored.appVersion, gitSha: stored.gitSha }, BUILD)
  assert.equal(stored.tallyVersion, 2)

  // Counting the sealed ballots again gives the same digest and the same result.
  const rows = await s.db.query<{ kind: 'ranking' | 'no' | 'invalid', ranking: string[] }>(`select kind, ranking from ballot where round_contest_id = '${BOX}' order by ranking`)
  const again = tallyContest(CONTEST_OF, ballotsOf(CONTEST_OF, rows.rows))
  assert.equal(stored.inputSha256, again.inputSha256)
  assert.equal(stored.inputSha256, inputDigest(CONTEST_OF, ballotsOf(CONTEST_OF, rows.rows)))
  assert.deepEqual(stored.result, JSON.parse(JSON.stringify(again.result)))
  assert.deepEqual(stored.outcome, JSON.parse(JSON.stringify(again.outcome)))

  const actions = await withClient(s.ownerUrl, async (client) => (await readAuditChain(client, ELECTION)).map((event) => [event.action, event.metadata]))
  assert.deepEqual(actions, [
    ['round.opened', { round: 'regular' }],
    ['round.closed', { round: 'regular', ballots: 2 }],
    ['result.computed', { contest: CONTEST, round: 'regular', inputSha256: stored.inputSha256, ballots: 2, outcome: 'runoff-required' }],
  ])
})

test('a close that cannot count rolls back, seal included: the round stays open until it can', DB, async (t) => {
  const s = await setup(t)
  await open(s, await as(s))
  const [first] = s.credentialIds as [string]
  assert.deepEqual(await cast(s, first), { cast: true })
  // A staged ballot the database accepts but election-core does not: one candidate ranked where two slots are active.
  await withClient(s.ownerUrl, (client) => client.query(
    `insert into ballot_box (election_id, round_contest_id, kind, ranking) values ('${ELECTION}', '${BOX}', 'ranking', array['${PAULA}']::uuid[])`,
  ))
  await assert.rejects(close(s, await as(s)), (err) => err instanceof TallyError && /incomplete/.test(err.message))
  assert.deepEqual(await states(s), { election: 'active', round: 'open' })
  await withClient(s.ownerUrl, async (client) => {
    const count = async (table: string) => (await client.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n
    assert.equal(await count('ballot_box'), 2)
    assert.equal(await count('result_snapshot'), 0)
    await client.query('begin; set local session_replication_role = replica; delete from ballot_box where cardinality(ranking) = 1; commit')
  })
  assert.deepEqual(await close(s, await as(s)), { ballots: 1, contests: [{ contestId: CONTEST, outcome: 'final' }] })
})

test('a closed round without its snapshots is an error, not an empty result', DB, async (t) => {
  const s = await setup(t)
  await open(s, await as(s))
  await close(s, await as(s))
  assert.equal((await s.db.tx((client) => readResults(client, ELECTION, ROUND))).length, 1)
  await withClient(s.ownerUrl, (client) => client.query('begin; set local session_replication_role = replica; delete from result_snapshot; commit'))
  await assert.rejects(s.db.tx((client) => readResults(client, ELECTION, ROUND)), (err) => err instanceof TallyError && /0 snapshots for 1 ballot boxes/.test(err.message))
})

test('a snapshot is written once: neither the runtime role nor the owner changes or removes it', DB, async (t) => {
  const s = await setup(t)
  await open(s, await as(s))
  await close(s, await as(s))
  for (const statement of [`update result_snapshot set app_version = 'x'`, 'delete from result_snapshot']) {
    await assert.rejects(s.db.query(statement), (err) => sqlState(err) === SQLSTATE.insufficientPrivilege, statement)
    await withClient(s.ownerUrl, (client) => assert.rejects(client.query(statement), (err) => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState, statement))
  }
  await assert.rejects(
    s.db.query(`insert into result_snapshot (election_id, round_contest_id, input_sha256, tally_version, app_version, git_sha, result, outcome) values ('${ELECTION}', '${BOX}', repeat('0', 64), 2, 'x', 'y', '{}', '{}')`),
    (err) => sqlState(err) === '23505',
    'one snapshot per box',
  )
})

test('turnout counts keys and entitlements of issued batches, in every state, and never a candidate', DB, async (t) => {
  const s = await setup(t)
  const turnout = (role: ElectionRole = 'owner') => s.db.tx(async (client) => {
    await as(s, role)
    return readTurnout(client, ELECTION, 'regular')
  })
  assert.deepEqual(await turnout(), { round: 'planned', keys: { issued: 3, used: 0 }, contests: [{ contestId: CONTEST, issued: 3, used: 0 }] })
  await open(s, await as(s))
  const [first, second] = s.credentialIds as [string, string]
  await cast(s, first)
  await cast(s, second)
  assert.deepEqual(await turnout(), { round: 'open', keys: { issued: 3, used: 2 }, contests: [{ contestId: CONTEST, issued: 3, used: 2 }] })
  await close(s, await as(s))
  assert.deepEqual(await turnout(), { round: 'closed', keys: { issued: 3, used: 2 }, contests: [{ contestId: CONTEST, issued: 3, used: 2 }] })
  // A voided batch's keys count for nothing.
  await withClient(s.ownerUrl, (client) => client.query(`begin; set local session_replication_role = replica; update credential_batch set state = 'void'; commit`))
  assert.deepEqual(await turnout(), { round: 'closed', keys: { issued: 0, used: 0 }, contests: [{ contestId: CONTEST, issued: 0, used: 0 }] })
  assert.deepEqual(await s.db.tx((client) => readTurnout(client, '00000000-0000-4000-8000-000000000000', 'regular')), { round: null, keys: { issued: 0, used: 0 }, contests: [] })
})
