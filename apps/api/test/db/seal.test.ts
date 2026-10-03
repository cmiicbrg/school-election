// The seal: closes an open round and moves its ballots under fresh ids,
// rewrites its entitlements, once; and waits for a vote in flight.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { sqlState } from '../../lib/pg-errors.ts'
import { createTestDatabase, DB, withClient } from '../helpers/db.ts'

const ELECTION = '3f2b8c1e-5a4d-4e6f-9b7a-0c1d2e3f4a5b'
const CONTEST = '5b4dae30-7c6f-4081-9d9c-2e3f4a5b6c7d'
const GROUP = '7d6fc052-9e81-42a3-9fbe-4a5b6c7d8e9f'
const ROUND = '8e7fd163-af92-43b4-8acf-5b6c7d8e9fa0'
const BOX = '9f80e274-b0a3-44c5-9bd0-6c7d8e9fa0b1'
const BATCH = 'a091f385-c1b4-45d6-8ce1-7d8e9fa0b1c2'
const PAULA = 'c2b315a7-e3d6-47f8-8ea3-9fa0b1c2d3e4'
const QUIRIN = 'd3c426b8-f4e7-4809-9fb4-a0b1c2d3e4f5'
const KEYS = ['00000000000000000000', '11111111111111111111', '22222222222222222222']

/** An active election, its regular round open, one two-candidate contest, and three keys entitled to its box; made as the owner. */
async function setup(t: TestContext) {
  const db = await createTestDatabase(t)
  await withClient(db.ownerUrl, (client) => client.query(
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
     insert into credential (election_id, batch_id, key) values ${KEYS.map((key) => `('${ELECTION}', '${BATCH}', '${key}')`).join(', ')};
     insert into credential_entitlement (election_id, credential_id, round_contest_id) select election_id, id, '${BOX}' from credential;`,
  ))
  return db
}

const refusedWith = (code: string) => (err: unknown) => sqlState(err) === code

/** One vote, as the application's ballot transaction will cast it. */
async function vote(client: pg.Client, key: string, ranking: string[]): Promise<void> {
  await client.query('begin')
  await client.query(`update credential_entitlement set consumed = true where round_contest_id = $1 and not consumed and credential_id = (select id from credential where key = $2)`, [BOX, key])
  await client.query('insert into ballot_box (election_id, round_contest_id, kind, ranking) values ($1, $2, $3, $4::uuid[])', [ELECTION, BOX, 'ranking', ranking])
  await client.query('commit')
}

async function open(ownerUrl: string): Promise<void> {
  await withClient(ownerUrl, (client) => client.query(`update election set state = 'active' where id = '${ELECTION}'; update round set state = 'open' where id = '${ROUND}'`))
}

test('the seal closes an open round, moves its ballots under fresh ids and rewrites its entitlements, once', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  await withClient(runtimeUrl, (client) => assert.rejects(client.query('select seal_round($1)', [ROUND]), refusedWith('55000')))
  await open(ownerUrl)
  await withClient(runtimeUrl, async (client) => {
    await vote(client, KEYS[0] ?? '', [PAULA, QUIRIN])
    await vote(client, KEYS[1] ?? '', [QUIRIN, PAULA])
    const { rows: [sealed] } = await client.query<{ n: number }>('select seal_round($1) as n', [ROUND])
    assert.equal(sealed?.n, 2)
    assert.equal((await client.query<{ state: string }>('select state from round where id = $1', [ROUND])).rows[0]?.state, 'closed')
    await assert.rejects(client.query('select seal_round($1)', [ROUND]), refusedWith('55000'))
    await assert.rejects(client.query('select seal_round($1)', ['00000000-0000-4000-8000-000000000000']), refusedWith('55000'))
  })
  await withClient(ownerUrl, async (client) => {
    assert.equal((await client.query('select 1 from ballot_box')).rowCount, 0)
    const { rows: ballots } = await client.query<{ kind: string, ranking: string[] }>('select kind, ranking from ballot where round_contest_id = $1 order by ranking', [BOX])
    assert.deepEqual(ballots, [{ kind: 'ranking', ranking: [PAULA, QUIRIN] }, { kind: 'ranking', ranking: [QUIRIN, PAULA] }])
    const { rows: entitlements } = await client.query<{ key: string, consumed: boolean }>(
      'select c.key, e.consumed from credential_entitlement e join credential c on c.id = e.credential_id order by c.key',
    )
    assert.deepEqual(entitlements, [{ key: KEYS[0], consumed: true }, { key: KEYS[1], consumed: true }, { key: KEYS[2], consumed: false }])
  })
})

test('a round without a single ballot seals as well', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  await open(ownerUrl)
  await withClient(runtimeUrl, async (client) => {
    assert.equal((await client.query<{ n: number }>('select seal_round($1) as n', [ROUND])).rows[0]?.n, 0)
    assert.equal((await client.query<{ n: number }>('select count(*)::int as n from credential_entitlement')).rows[0]?.n, 3)
  })
})

test('the seal waits for a vote in flight, and a vote that comes after it finds the round closed', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  await open(ownerUrl)
  // Two sessions of the runtime role, closed before the database is dropped.
  const voter = new pg.Client({ connectionString: runtimeUrl })
  const sealer = new pg.Client({ connectionString: runtimeUrl })
  await Promise.all([voter.connect(), sealer.connect()])
  try {
    await race(voter, sealer, ownerUrl)
  } finally {
    await Promise.all([voter.end(), sealer.end()])
  }
})

async function race(voter: pg.Client, sealer: pg.Client, ownerUrl: string): Promise<void> {
  await voter.query('begin')
  await voter.query(`update credential_entitlement set consumed = true where credential_id = (select id from credential where key = $1)`, [KEYS[0]])
  let sealed = false
  const sealing = sealer.query<{ n: number }>('select seal_round($1) as n', [ROUND]).then((result) => {
    sealed = true
    return result
  })
  await sleep(300)
  assert.equal(sealed, false, 'the seal waits for the vote to commit')
  const { rows: [waiting] } = await withClient(ownerUrl, (client) => client.query<{ wait_event_type: string }>(
    `select wait_event_type from pg_stat_activity where usename = 'school_election_app' and query like 'select seal_round%'`,
  ))
  assert.equal(waiting?.wait_event_type, 'Lock')

  await voter.query('insert into ballot_box (election_id, round_contest_id, kind, ranking) values ($1, $2, $3, $4::uuid[])', [ELECTION, BOX, 'ranking', [PAULA, QUIRIN]])
  await voter.query('commit')
  assert.equal((await sealing).rows[0]?.n, 1, 'the vote in flight was sealed')

  // Too late: the entitlement is frozen and the box takes nothing.
  await assert.rejects(
    voter.query(`update credential_entitlement set consumed = true where credential_id = (select id from credential where key = $1)`, [KEYS[1]]),
    refusedWith('55000'),
  )
  await assert.rejects(
    voter.query('insert into ballot_box (election_id, round_contest_id, kind, ranking) values ($1, $2, $3, $4::uuid[])', [ELECTION, BOX, 'ranking', [PAULA, QUIRIN]]),
    refusedWith('55000'),
  )
}
