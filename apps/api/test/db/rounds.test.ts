// Opening and closing with the count, as the round routes call them: the
// lifecycle's say, the database's steps in order, the snapshot a close
// writes and what it holds, a close that cannot count, turnout, and that a
// snapshot never changes.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { validateBallot, type CastBallot, type Contest } from '@school-election/election-core'
import { lockElection, readAuditChain } from '../../lib/audit.ts'
import { castBallot, type CastResult } from '../../lib/ballot-box.ts'
import { createDatabase, type Database } from '../../lib/db.ts'
import { Refusal, type ElectionAccess } from '../../lib/election-access.ts'
import type { ElectionRole } from '../../lib/permissions.ts'
import { SQLSTATE, sqlState } from '../../lib/pg-errors.ts'
import { closeAndTally, openRound, readTurnout } from '../../lib/rounds.ts'
import { ballotsOf, inputDigest, readResults, tallyContest, TallyError } from '../../lib/tally.ts'
import { createTestDatabase, DB, withClient } from '../helpers/db.ts'
import { accessAs } from '../helpers/elections.ts'

const ELECTION = '3f2b8c1e-5a4d-4e6f-9b7a-0c1d2e3f4a5b'
const CONTEST = '5b4dae30-7c6f-4081-9d9c-2e3f4a5b6c7d'
const GROUP = '7d6fc052-9e81-42a3-9fbe-4a5b6c7d8e9f'
const ROUND = '8e7fd163-af92-43b4-8acf-5b6c7d8e9fa0'
const BOX = '9f80e274-b0a3-44c5-9bd0-6c7d8e9fa0b1'
const BATCH = 'a091f385-c1b4-45d6-8ce1-7d8e9fa0b1c2'
const PAULA = 'c2b315a7-e3d6-47f8-8ea3-9fa0b1c2d3e4'
const QUIRIN = 'd3c426b8-f4e7-4809-9fb4-a0b1c2d3e4f5'
const CONTEST_OF: Contest = { id: CONTEST, rulesetId: 'at-representative-v1', candidateIds: [PAULA, QUIRIN] }
const BUILD = { version: 'v9.9.9', gitSha: 'abcdef0' }

interface Setup {
  db: Database
  ownerUrl: string
  credentialIds: string[]
}

/** A prepared election with one two-candidate contest, its planned round, and `keys` keys entitled to its box; made as the owner. */
async function setup(t: TestContext, keys = 3): Promise<Setup> {
  const testDb = await createTestDatabase(t)
  await withClient(testDb.ownerUrl, (client) => client.query(
    `insert into election (id, title) values ('${ELECTION}', 'Wahl');
     insert into contest (id, election_id, title, ruleset_id) values ('${CONTEST}', '${ELECTION}', 'Klassensprecher/in', 'at-representative-v1');
     insert into candidate (id, election_id, contest_id, surname, given_name) values
       ('${PAULA}', '${ELECTION}', '${CONTEST}', 'Berger', 'Paula'), ('${QUIRIN}', '${ELECTION}', '${CONTEST}', 'Huber', 'Quirin');
     insert into voter_group (id, election_id, name) values ('${GROUP}', '${ELECTION}', '1A');
     insert into voter_group_contest (election_id, voter_group_id, contest_id) values ('${ELECTION}', '${GROUP}', '${CONTEST}');
     insert into round (id, election_id, kind) values ('${ROUND}', '${ELECTION}', 'regular');
     insert into round_contest (id, election_id, round_id, contest_id) values ('${BOX}', '${ELECTION}', '${ROUND}', '${CONTEST}');
     update election set state = 'prepared' where id = '${ELECTION}';
     insert into credential_batch (id, election_id, voter_group_id, round_kind) values ('${BATCH}', '${ELECTION}', '${GROUP}', 'regular');
     insert into credential (election_id, batch_id, key) select '${ELECTION}', '${BATCH}', lpad(n::text, 20, '0') from generate_series(1, ${keys}) as n;
     insert into credential_entitlement (election_id, credential_id, round_contest_id) select election_id, id, '${BOX}' from credential;`,
  ))
  const { rows } = await withClient(testDb.ownerUrl, (client) => client.query<{ id: string }>('select id from credential order by key'))
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  return { db, ownerUrl: testDb.ownerUrl, credentialIds: rows.map((row) => row.id) }
}

const ranking = (order: string[]): CastBallot => {
  const result = validateBallot(CONTEST_OF, { kind: 'ranking', ranking: order })
  assert.ok(result.ok)
  return result.ballot
}

const cast = (s: Setup, credentialId: string, ballot = ranking([PAULA, QUIRIN])): Promise<CastResult> =>
  s.db.tx((client) => castBallot(client, { credentialId, roundContestId: BOX, contest: CONTEST_OF, ballot }))

const as = (s: Setup, role: ElectionRole = 'owner') => accessAs(s.ownerUrl, ELECTION, role)

/** As the routes run them: in a transaction, holding the election's lock. */
const open = (s: Setup, access: ElectionAccess) => s.db.tx(async (client) => {
  await lockElection(client, ELECTION)
  return openRound(client, access)
})
const close = (s: Setup, access: ElectionAccess) => s.db.tx(async (client) => {
  await lockElection(client, ELECTION)
  return closeAndTally(client, access, BUILD)
})

const refusedWith = (statusCode: number, code: string) => (err: unknown) => err instanceof Refusal && err.statusCode === statusCode && err.code === code

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
