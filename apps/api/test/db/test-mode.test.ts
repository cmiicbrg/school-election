// The test mode at the database and library level: a round in test mode
// takes ballots and uses keys up like an open one, cannot be sealed or
// left by a direct statement, keeps its entitlements as they are, and ends
// with nothing kept; its ballots are read only while it runs. That nothing
// of the election changes while a test runs is the lifecycle's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lockElection, readAuditChain } from '../../lib/audit.ts'
import type { ElectionAccess } from '../../lib/election-access.ts'
import { SQLSTATE, sqlState } from '../../lib/pg-errors.ts'
import { closeAndTally, endTest, openRound, readTurnout, startTest } from '../../lib/rounds.ts'
import { tallyTest } from '../../lib/tally.ts'
import { DB, withClient } from '../helpers/db.ts'
import { as, BOX, cast, CONTEST, ELECTION, GROUP, PAULA, QUIRIN, ranking, refusedWith, ROUND, setup, type Setup } from '../helpers/representative-election.ts'

const BUILD = { version: 'dev', gitSha: 'unknown' }

const inTx = <T>(s: Setup, fn: (client: Parameters<Parameters<Setup['db']['tx']>[0]>[0], access: ElectionAccess) => Promise<T>, role: 'owner' | 'admin' | 'witness' = 'owner') =>
  s.db.tx(async (client) => {
    await lockElection(client, ELECTION)
    return fn(client, await as(s, role))
  })

const start = (s: Setup, role?: 'owner' | 'admin' | 'witness') => inTx(s, (client, access) => startTest(client, access), role)
const end = (s: Setup, role?: 'owner' | 'admin' | 'witness') => inTx(s, (client, access) => endTest(client, access), role)

async function roundState(s: Setup): Promise<string> {
  return withClient(s.ownerUrl, async (client) => (await client.query<{ state: string }>('select state from round where id = $1', [ROUND])).rows[0]?.state ?? '')
}

async function counts(s: Setup): Promise<{ staged: number, used: number }> {
  return withClient(s.ownerUrl, async (client) => (await client.query<{ staged: number, used: number }>(
    'select (select count(*)::int from ballot_box) as staged, (select count(*)::int from credential_entitlement where consumed) as used',
  )).rows[0]!)
}

test('a test takes ballots and uses keys up like an open round, and ends with nothing kept', DB, async (t) => {
  const s = await setup(t)
  await assert.rejects(end(s), refusedWith(409, 'round_planned'))
  await assert.rejects(start(s, 'witness'), refusedWith(403, 'forbidden'))
  await start(s)
  assert.equal(await roundState(s), 'testing')
  await assert.rejects(start(s), refusedWith(409, 'round_testing'))
  const [first, second, third] = s.credentialIds as [string, string, string]
  assert.deepEqual(await cast(s, first), { cast: true })
  assert.deepEqual(await cast(s, second, ranking([QUIRIN, PAULA])), { cast: true })
  assert.deepEqual(await cast(s, first), { cast: false, reason: 'already-voted' })
  assert.deepEqual(await counts(s), { staged: 2, used: 2 })
  assert.deepEqual((await s.db.tx((client) => readTurnout(client, ELECTION, 'regular'))).keys, { issued: 3, used: 2 })

  const ended = await end(s, 'admin')
  assert.deepEqual(ended, { ballots: 2, keys: 2 })
  assert.equal(await roundState(s), 'planned')
  assert.deepEqual(await counts(s), { staged: 0, used: 0 })
  assert.deepEqual(await cast(s, third), { cast: false, reason: 'refused' })
  const actions = await withClient(s.ownerUrl, async (client) => (await readAuditChain(client, ELECTION)).map((event) => [event.action, event.metadata]))
  assert.deepEqual(actions, [['test.started', { round: 'regular' }], ['test.ended', { round: 'regular', ballots: 2, keys: 2 }]])
})

test('the test result is counted from the staged ballots, only while the test runs', DB, async (t) => {
  const s = await setup(t)
  const result = () => s.db.tx((client) => tallyTest(client, ELECTION, ROUND, BUILD))
  // Before and after a test, the read refuses as the route's guard does, for a test that ended under a request.
  await assert.rejects(result(), refusedWith(409, 'round_planned'))
  await start(s)
  assert.deepEqual((await result()).map((contest) => [contest.contestId, (contest.result as { statistics: { validBallots: number } }).statistics.validBallots]), [[CONTEST, 0]])
  const [first, second] = s.credentialIds as [string, string]
  await cast(s, first)
  await cast(s, second)
  const [counted] = await result()
  assert.ok(counted)
  assert.equal((counted.result as { statistics: { validBallots: number } }).statistics.validBallots, 2)
  assert.equal((counted.outcome as { kind: string }).kind, 'final')
  assert.equal(counted.appVersion, 'dev')
  await end(s)
  await assert.rejects(result(), refusedWith(409, 'round_planned'))
})

test('the database keeps a test apart: no seal, no direct way out, the entitlements as they are, and the runtime role reads no staged ballot', DB, async (t) => {
  const s = await setup(t)
  await start(s)
  await cast(s, s.credentialIds[0] ?? '')
  for (const statement of ['select seal_round($1)', 'update round set state = \'planned\' where id = $1', 'update round set state = \'open\' where id = $1']) {
    await assert.rejects(s.db.query(statement, [ROUND]), (err) => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState, statement)
  }
  // The entitlements of a round in test mode are as fixed as an open round's: none added or removed. Runoff keys are not concerned.
  await assert.rejects(
    s.db.query(`insert into credential_entitlement (election_id, credential_id, round_contest_id) select '${ELECTION}', id, '${BOX}' from credential limit 1`),
    (err) => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState,
  )
  // Removing an entitlement is nobody's during a test: the privilege stops the runtime role, the window the owner.
  await assert.rejects(s.db.query('delete from credential_entitlement'), (err) => sqlState(err) === SQLSTATE.insufficientPrivilege)
  await withClient(s.ownerUrl, (client) => assert.rejects(client.query('delete from credential_entitlement'), (err) => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState))
  await s.db.query(`insert into credential_batch (election_id, voter_group_id, round_kind) values ('${ELECTION}', '${GROUP}', 'runoff')`)
  await assert.rejects(s.db.query('select * from ballot_box'), (err) => sqlState(err) === SQLSTATE.insufficientPrivilege)
  await assert.rejects(s.db.query('delete from ballot_box'), (err) => sqlState(err) === SQLSTATE.insufficientPrivilege)
  await assert.rejects(s.db.query('update credential_entitlement set consumed = false'), (err) => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState)
  // The owner's direct statements are bound too; only end_test leaves a test.
  await withClient(s.ownerUrl, (client) => assert.rejects(client.query('update round set state = \'planned\' where id = $1', [ROUND]), (err) => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState))
  await assert.rejects(inTx(s, (client, access) => closeAndTally(client, access, BUILD)), refusedWith(409, 'round_testing'))
  assert.equal(await roundState(s), 'testing')
})

test('every change of a round\'s state is a new phase, and nothing but a change of state sets one', DB, async (t) => {
  const s = await setup(t)
  const phase = () => withClient(s.ownerUrl, async (client) => (await client.query<{ phase: string }>('select phase from round where id = $1', [ROUND])).rows[0]?.phase ?? '')
  const phases = [await phase()]
  for (const step of [start, end, start, end]) {
    await step(s)
    phases.push(await phase())
  }
  assert.equal(new Set(phases).size, phases.length, 'a test and its end, each time, is a phase of its own')
  await inTx(s, (client, access) => openRound(client, access))
  phases.push(await phase())
  assert.equal(new Set(phases).size, phases.length, 'opening is one more')
  // The phase is the trigger's: the runtime role may not name the column, and the owner's statement is refused.
  await assert.rejects(s.db.query('update round set phase = gen_random_uuid() where id = $1', [ROUND]), (err) => sqlState(err) === SQLSTATE.insufficientPrivilege)
  await withClient(s.ownerUrl, (client) => assert.rejects(client.query('update round set phase = gen_random_uuid() where id = $1', [ROUND]), (err) => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState))
  assert.equal(await phase(), phases.at(-1))
})

test('opening from a test ends it first: the test\'s ballots are gone before the first real vote, and both are audited', DB, async (t) => {
  const s = await setup(t)
  await start(s)
  const [first, second] = s.credentialIds as [string, string]
  await cast(s, first)
  await inTx(s, (client, access) => openRound(client, access))
  assert.equal(await roundState(s), 'open')
  assert.deepEqual(await counts(s), { staged: 0, used: 0 })
  assert.deepEqual(await cast(s, first), { cast: true })
  assert.deepEqual(await cast(s, second), { cast: true })
  const closed = await inTx(s, (client, access) => closeAndTally(client, access, BUILD))
  assert.equal(closed.ballots, 2)
  const actions = await withClient(s.ownerUrl, async (client) => (await readAuditChain(client, ELECTION)).map((event) => event.action))
  assert.deepEqual(actions, ['test.started', 'test.ended', 'round.opened', 'round.closed', 'result.computed'])
  // The box's ballots after the seal are the real votes alone.
  const { rows } = await withClient(s.ownerUrl, (client) => client.query<{ n: number }>('select count(*)::int as n from ballot where round_contest_id = $1', [BOX]))
  assert.equal(rows[0]?.n, 2)
})
