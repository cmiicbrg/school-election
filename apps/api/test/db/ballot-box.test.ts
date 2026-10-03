// The ballot tables as the runtime role meets them: a write-only staging
// table while the round is open, sealed ballots it can only read, the
// shape of a ballot, and the transitions of a round.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type pg from 'pg'
import { BALLOT_KINDS } from '@school-election/election-core'
import { sqlState } from '../../lib/pg-errors.ts'
import { checkedValues, createTestDatabase, DB, withClient } from '../helpers/db.ts'

const ELECTION = '3f2b8c1e-5a4d-4e6f-9b7a-0c1d2e3f4a5b'
const SPEAKER = '5b4dae30-7c6f-4081-9d9c-2e3f4a5b6c7d'
const POLL = '6c5ebf41-8d70-4192-8ead-3f4a5b6c7d8e'
const GROUP = '7d6fc052-9e81-42a3-9fbe-4a5b6c7d8e9f'
const ROUND = '8e7fd163-af92-43b4-8acf-5b6c7d8e9fa0'
const SPEAKER_BOX = '9f80e274-b0a3-44c5-9bd0-6c7d8e9fa0b1'
const POLL_BOX = 'a091f385-c1b4-45d6-8ce1-7d8e9fa0b1c2'
const BATCH = 'b1a20496-d2c5-46e7-9df2-8e9fa0b1c2d3'
const PAULA = 'c2b315a7-e3d6-47f8-8ea3-9fa0b1c2d3e4'
const QUIRIN = 'd3c426b8-f4e7-4809-9fb4-a0b1c2d3e4f5'
const JA = 'e4d537c9-05f8-491a-8ac5-b1c2d3e4f506'
const KEY_A = '00000000000000000000'
const KEY_B = '11111111111111111111'

/**
 * A prepared election with a two-candidate Schulsprecherwahl and a
 * single-candidate poll, one class in both, the planned round with its
 * two ballot boxes and two keys entitled to both; made as the owner.
 */
async function setup(t: TestContext) {
  const db = await createTestDatabase(t)
  await withClient(db.ownerUrl, (client) => client.query(
    `insert into election (id, title) values ('${ELECTION}', 'Wahl');
     insert into contest (id, election_id, title, ruleset_id) values
       ('${SPEAKER}', '${ELECTION}', 'Schulsprecher/in', 'at-school-speaker-v1'), ('${POLL}', '${ELECTION}', 'Abstimmung', 'single-choice-v1');
     insert into candidate (id, election_id, contest_id, surname, given_name) values
       ('${PAULA}', '${ELECTION}', '${SPEAKER}', 'Berger', 'Paula'), ('${QUIRIN}', '${ELECTION}', '${SPEAKER}', 'Huber', 'Quirin'),
       ('${JA}', '${ELECTION}', '${POLL}', 'Ja', '');
     insert into voter_group (id, election_id, name) values ('${GROUP}', '${ELECTION}', '1A');
     insert into voter_group_contest (election_id, voter_group_id, contest_id) values ('${ELECTION}', '${GROUP}', '${SPEAKER}'), ('${ELECTION}', '${GROUP}', '${POLL}');
     insert into round (id, election_id, kind) values ('${ROUND}', '${ELECTION}', 'regular');
     insert into round_contest (id, election_id, round_id, contest_id) values
       ('${SPEAKER_BOX}', '${ELECTION}', '${ROUND}', '${SPEAKER}'), ('${POLL_BOX}', '${ELECTION}', '${ROUND}', '${POLL}');
     update election set state = 'prepared' where id = '${ELECTION}';
     insert into credential_batch (id, election_id, voter_group_id, round_kind) values ('${BATCH}', '${ELECTION}', '${GROUP}', 'regular');
     insert into credential (election_id, batch_id, key) values ('${ELECTION}', '${BATCH}', '${KEY_A}'), ('${ELECTION}', '${BATCH}', '${KEY_B}');
     insert into credential_entitlement (election_id, credential_id, round_contest_id)
       select c.election_id, c.id, rc.id from credential c, round_contest rc where c.election_id = '${ELECTION}';`,
  ))
  return db
}

const refusedWith = (code: string) => (err: unknown) => sqlState(err) === code

async function refused(client: pg.Client, code: string, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await assert.rejects(client.query(statement), refusedWith(code), statement)
  }
}

const stage = (box: string, kind: string, ranking: string[]) =>
  `insert into ballot_box (election_id, round_contest_id, kind, ranking) values ('${ELECTION}', '${box}', '${kind}', '{${ranking.join(',')}}')`

/** Moves the election and its regular round on, as the owner, past the triggers. */
async function forceOn(ownerUrl: string, election: string, round: string): Promise<void> {
  await withClient(ownerUrl, (client) => client.query(
    `begin; set local session_replication_role = replica;
     update election set state = '${election}' where id = '${ELECTION}'; update round set state = '${round}' where id = '${ROUND}'; commit`,
  ))
}

test('a ballot\'s kind is one the code knows, staged and sealed alike', DB, async (t) => {
  const { ownerUrl } = await setup(t)
  assert.deepEqual(await checkedValues(ownerUrl, 'ballot_box', 'kind'), [...BALLOT_KINDS])
  assert.deepEqual(await checkedValues(ownerUrl, 'ballot', 'kind'), [...BALLOT_KINDS])
})

test('the runtime role stages ballots and nothing else: it neither reads, changes nor removes them, and writes no sealed one', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  await forceOn(ownerUrl, 'active', 'open')
  await withClient(runtimeUrl, async (client) => {
    await client.query(stage(SPEAKER_BOX, 'ranking', [PAULA, QUIRIN]))
    await refused(client, '42501', [
      'select * from ballot_box',
      'select count(*) from ballot_box',
      `update ballot_box set kind = 'invalid'`,
      'delete from ballot_box',
      stage(SPEAKER_BOX, 'ranking', [PAULA, QUIRIN]).replace('ballot_box', 'ballot'),
      `update ballot set kind = 'invalid'`,
      'delete from ballot',
    ])
    assert.equal((await client.query<{ n: number }>('select count(*)::int as n from ballot')).rows[0]?.n, 0)
  })
})

test('a ballot is staged only while its round is open, and only one that fits its box', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  await withClient(runtimeUrl, (client) => refused(client, '55000', [stage(SPEAKER_BOX, 'ranking', [PAULA, QUIRIN])]))
  await forceOn(ownerUrl, 'active', 'open')
  await withClient(runtimeUrl, async (client) => {
    await client.query(stage(SPEAKER_BOX, 'ranking', [PAULA, QUIRIN]))
    await client.query(stage(SPEAKER_BOX, 'invalid', []))
    await client.query(stage(POLL_BOX, 'ranking', [JA]))
    await client.query(stage(POLL_BOX, 'no', []))
    // The shape: a ranking has one to six entries, the other kinds none.
    await refused(client, '23514', [stage(SPEAKER_BOX, 'ranking', []), stage(POLL_BOX, 'no', [JA]), stage(SPEAKER_BOX, 'invalid', [PAULA])])
    // What a ranking names: each candidate once, of its own contest, and "Nein" only against a single candidate.
    await refused(client, '55000', [
      stage(SPEAKER_BOX, 'ranking', [PAULA, PAULA]),
      stage(SPEAKER_BOX, 'ranking', [PAULA, JA]),
      stage(POLL_BOX, 'ranking', [PAULA]),
      stage(SPEAKER_BOX, 'no', []),
    ])
  })
  // The checks hold where no trigger runs, and a null entry is no candidate.
  await withClient(ownerUrl, async (client) => {
    await client.query('set session_replication_role = replica')
    await refused(client, '23514', [
      stage(SPEAKER_BOX, 'ranking', [PAULA, 'NULL']),
      stage(SPEAKER_BOX, 'ranking', []),
      `insert into ballot_box (election_id, round_contest_id, kind, ranking) values ('${ELECTION}', '${SPEAKER_BOX}', 'ranking', '{{${PAULA}},{${QUIRIN}}}')`,
    ])
  })
  await forceOn(ownerUrl, 'active', 'closed')
  await withClient(runtimeUrl, (client) => refused(client, '55000', [stage(SPEAKER_BOX, 'ranking', [PAULA, QUIRIN]), stage(POLL_BOX, 'no', [])]))
})

test('a round moves only along its transitions, opens only once its election is active, and leaves the open state only through the seal', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  const move = (state: string) => `update round set state = '${state}' where id = '${ROUND}'`
  await withClient(runtimeUrl, async (client) => {
    // Prepared: the round stays planned.
    await refused(client, '55000', [move('closed'), move('open')])
    await refused(client, '42501', [`update round set kind = 'runoff' where id = '${ROUND}'`, 'delete from round'])
    await client.query(`update election set state = 'active' where id = '${ELECTION}'`)
    await client.query(move('open'))
    await refused(client, '55000', [move('planned'), move('closed')])
  })
  // The owner's direct statements are bound the same way.
  await withClient(ownerUrl, (client) => refused(client, '55000', [move('closed'), move('planned'), `update round set kind = 'runoff' where id = '${ROUND}'`]))
  await withClient(runtimeUrl, async (client) => {
    await client.query('select seal_round($1)', [ROUND])
    assert.equal((await client.query<{ state: string }>('select state from round where id = $1', [ROUND])).rows[0]?.state, 'closed')
    await refused(client, '55000', [move('open'), move('planned')])
  })
})
