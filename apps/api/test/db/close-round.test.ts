// closeRound as the close route will call it: the lifecycle's say before
// and after, the seal, the audit event with the count, who may close, and
// a close racing the votes still coming in.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { validateBallot, type CastBallot, type Contest } from '@school-election/election-core'
import { lockElection, readAuditChain } from '../../lib/audit.ts'
import { verifyAuditChain } from '../../lib/audit-chain.ts'
import { castBallot, type CastResult } from '../../lib/ballot-box.ts'
import { createDatabase, type Database } from '../../lib/db.ts'
import { Refusal, type ElectionAccess } from '../../lib/election-access.ts'
import type { ElectionRole } from '../../lib/permissions.ts'
import { closeRound } from '../../lib/rounds.ts'
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

async function open(ownerUrl: string): Promise<void> {
  await withClient(ownerUrl, (client) => client.query(`update election set state = 'active' where id = '${ELECTION}'; update round set state = 'open' where id = '${ROUND}'`))
}

const RANKING = ((): CastBallot => {
  const result = validateBallot(CONTEST_OF, { kind: 'ranking', ranking: [PAULA, QUIRIN] })
  assert.ok(result.ok)
  return result.ballot
})()

const cast = (s: Setup, credentialId: string): Promise<CastResult> =>
  s.db.tx((client) => castBallot(client, { credentialId, roundContestId: BOX, contest: CONTEST_OF, ballot: RANKING }))

/** closeRound as the route runs it: in a transaction, holding the election's lock. */
const close = (s: Setup, access: ElectionAccess, kind: 'regular' | 'runoff' = 'regular') => s.db.tx(async (client) => {
  await lockElection(client, ELECTION)
  return closeRound(client, access, kind)
})

const refusedWith = (statusCode: number, code: string) => (err: unknown) => err instanceof Refusal && err.statusCode === statusCode && err.code === code

const as = (s: Setup, role: ElectionRole = 'owner') => accessAs(s.ownerUrl, ELECTION, role)

test('a round closes once it is open, with its audit event, and the lifecycle refuses it before and afterwards', DB, async (t) => {
  const s = await setup(t)
  await assert.rejects(close(s, await as(s)), refusedWith(409, 'round_planned'))
  await open(s.ownerUrl)
  const stale = await as(s)
  assert.deepEqual(await cast(s, s.credentialIds[0] ?? ''), { cast: true })
  assert.deepEqual(await cast(s, s.credentialIds[1] ?? ''), { cast: true })

  assert.deepEqual(await close(s, stale), { ballots: 2 })
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
  assert.deepEqual(await close(s, await as(s, 'admin')), { ballots: 0 })
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
