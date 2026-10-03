// castBallot as the voter route will call it: one key votes once in each
// contest it is entitled to, the reasons for anything else are told
// apart, a race on one entitlement casts one ballot, and the database's
// refusals come back as such.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { validateBallot, type CastBallot, type Contest } from '@school-election/election-core'
import { castBallot, type CastResult } from '../../lib/ballot-box.ts'
import { createDatabase, type Database } from '../../lib/db.ts'
import { createTestDatabase, DB, withClient } from '../helpers/db.ts'

const ELECTION = '3f2b8c1e-5a4d-4e6f-9b7a-0c1d2e3f4a5b'
const SPEAKER = '5b4dae30-7c6f-4081-9d9c-2e3f4a5b6c7d'
const POLL = '6c5ebf41-8d70-4192-8ead-3f4a5b6c7d8e'
const CLASS_1A = '7d6fc052-9e81-42a3-9fbe-4a5b6c7d8e9f'
const CLASS_2B = '7e70d163-af92-43b4-8acf-5b6c7d8e9fa0'
const ROUND = '8e7fd163-af92-43b4-8acf-5b6c7d8e9fa0'
const SPEAKER_BOX = '9f80e274-b0a3-44c5-9bd0-6c7d8e9fa0b1'
const POLL_BOX = 'a091f385-c1b4-45d6-8ce1-7d8e9fa0b1c2'
const BATCH_1A = 'b1a20496-d2c5-46e7-9df2-8e9fa0b1c2d3'
const BATCH_2B = 'b2b315a7-e3d6-47f8-8ea3-9fa0b1c2d3e4'
const PAULA = 'c2b315a7-e3d6-47f8-8ea3-9fa0b1c2d3e4'
const QUIRIN = 'd3c426b8-f4e7-4809-9fb4-a0b1c2d3e4f5'
const RENATE = 'd4d537c9-05f8-491a-8ac5-b1c2d3e4f506'
const JA = 'e4d537c9-05f8-491a-8ac5-b1c2d3e4f506'
const KEY_A = '00000000000000000000'
const KEY_B = '11111111111111111111'
const KEY_C = '22222222222222222222'

const SPEAKER_CONTEST: Contest = { id: SPEAKER, rulesetId: 'at-school-speaker-v1', candidateIds: [PAULA, QUIRIN, RENATE] }
const POLL_CONTEST: Contest = { id: POLL, rulesetId: 'single-choice-v1', candidateIds: [JA] }

interface Setup {
  db: Database
  ownerUrl: string
  runtimeUrl: string
  /** Credential ids by key. */
  credential: Record<string, string>
}

/**
 * An active election with its round open: a three-candidate
 * Schulsprecherwahl and a single-candidate poll, class 1A voting in both
 * with keys A and B, class 2B in the Schulsprecherwahl only with key C;
 * made as the owner.
 */
async function setup(t: TestContext): Promise<Setup> {
  const testDb = await createTestDatabase(t)
  await withClient(testDb.ownerUrl, (client) => client.query(
    `insert into election (id, title) values ('${ELECTION}', 'Wahl');
     insert into contest (id, election_id, title, ruleset_id) values
       ('${SPEAKER}', '${ELECTION}', 'Schulsprecher/in', 'at-school-speaker-v1'), ('${POLL}', '${ELECTION}', 'Abstimmung', 'single-choice-v1');
     insert into candidate (id, election_id, contest_id, surname, given_name) values
       ('${PAULA}', '${ELECTION}', '${SPEAKER}', 'Berger', 'Paula'), ('${QUIRIN}', '${ELECTION}', '${SPEAKER}', 'Huber', 'Quirin'),
       ('${RENATE}', '${ELECTION}', '${SPEAKER}', 'Wagner', 'Renate'), ('${JA}', '${ELECTION}', '${POLL}', 'Ja', '');
     insert into voter_group (id, election_id, name) values ('${CLASS_1A}', '${ELECTION}', '1A'), ('${CLASS_2B}', '${ELECTION}', '2B');
     insert into voter_group_contest (election_id, voter_group_id, contest_id) values
       ('${ELECTION}', '${CLASS_1A}', '${SPEAKER}'), ('${ELECTION}', '${CLASS_1A}', '${POLL}'), ('${ELECTION}', '${CLASS_2B}', '${SPEAKER}');
     insert into round (id, election_id, kind) values ('${ROUND}', '${ELECTION}', 'regular');
     insert into round_contest (id, election_id, round_id, contest_id) values
       ('${SPEAKER_BOX}', '${ELECTION}', '${ROUND}', '${SPEAKER}'), ('${POLL_BOX}', '${ELECTION}', '${ROUND}', '${POLL}');
     update election set state = 'prepared' where id = '${ELECTION}';
     insert into credential_batch (id, election_id, voter_group_id, round_kind) values
       ('${BATCH_1A}', '${ELECTION}', '${CLASS_1A}', 'regular'), ('${BATCH_2B}', '${ELECTION}', '${CLASS_2B}', 'regular');
     insert into credential (election_id, batch_id, key) values
       ('${ELECTION}', '${BATCH_1A}', '${KEY_A}'), ('${ELECTION}', '${BATCH_1A}', '${KEY_B}'), ('${ELECTION}', '${BATCH_2B}', '${KEY_C}');
     insert into credential_entitlement (election_id, credential_id, round_contest_id)
       select c.election_id, c.id, rc.id
         from credential c join credential_batch b on b.id = c.batch_id
         join voter_group_contest m on m.voter_group_id = b.voter_group_id
         join round_contest rc on rc.contest_id = m.contest_id;
     update election set state = 'active' where id = '${ELECTION}';
     update round set state = 'open' where id = '${ROUND}';`,
  ))
  const { rows } = await withClient(testDb.ownerUrl, (client) => client.query<{ key: string, id: string }>('select key, id from credential'))
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  return { db, ownerUrl: testDb.ownerUrl, runtimeUrl: testDb.runtimeUrl, credential: Object.fromEntries(rows.map((row) => [row.key, row.id])) }
}

function ballot(contest: Contest, input: unknown): CastBallot {
  const result = validateBallot(contest, input)
  assert.ok(result.ok, 'the test casts valid ballots')
  return result.ballot
}

const cast = (s: Setup, key: string, roundContestId: string, contest: Contest, cast: CastBallot): Promise<CastResult> =>
  s.db.tx((client) => castBallot(client, { credentialId: s.credential[key] ?? '', roundContestId, contest, ballot: cast }))

const RANKING = ballot(SPEAKER_CONTEST, { kind: 'ranking', ranking: [PAULA, QUIRIN, RENATE] })
const NO = ballot(POLL_CONTEST, { kind: 'no' })

test('a key votes once in each contest it is entitled to, and the reasons for anything else are told apart', DB, async (t) => {
  const s = await setup(t)
  const xmins = await withClient(s.ownerUrl, (client) => client.query<{ id: string, xmin: string }>('select id, xmin::text from credential order by id'))

  assert.deepEqual(await cast(s, KEY_A, SPEAKER_BOX, SPEAKER_CONTEST, RANKING), { cast: true })
  assert.deepEqual(await cast(s, KEY_A, POLL_BOX, POLL_CONTEST, NO), { cast: true })
  assert.deepEqual(await cast(s, KEY_A, SPEAKER_BOX, SPEAKER_CONTEST, RANKING), { cast: false, reason: 'already-voted' })
  assert.deepEqual(await cast(s, KEY_C, POLL_BOX, POLL_CONTEST, NO), { cast: false, reason: 'not-entitled' })
  // A ballot for the poll in the Schulsprecherwahl's box: refused, and the key's entitlement there stays unused.
  assert.deepEqual(await cast(s, KEY_B, SPEAKER_BOX, POLL_CONTEST, NO), { cast: false, reason: 'wrong-contest' })
  // A ballot that election-core validated for another contest is a programming error, not a vote.
  await assert.rejects(cast(s, KEY_B, SPEAKER_BOX, SPEAKER_CONTEST, NO), TypeError)
  await withClient(s.runtimeUrl, (client) => assert.rejects(
    castBallot(client, { credentialId: s.credential[KEY_B] ?? '', roundContestId: SPEAKER_BOX, contest: SPEAKER_CONTEST, ballot: RANKING }),
    /inside the transaction/,
  ))

  await withClient(s.ownerUrl, async (client) => {
    const { rows: staged } = await client.query<{ round_contest_id: string, kind: string, ranking: string[] }>('select round_contest_id, kind, ranking from ballot_box order by kind')
    assert.deepEqual(staged, [{ round_contest_id: POLL_BOX, kind: 'no', ranking: [] }, { round_contest_id: SPEAKER_BOX, kind: 'ranking', ranking: [PAULA, QUIRIN, RENATE] }])
    const { rows: used } = await client.query<{ key: string, box: string }>(
      'select c.key, e.round_contest_id as box from credential_entitlement e join credential c on c.id = e.credential_id where e.consumed order by 1, 2',
    )
    assert.deepEqual(used.toSorted((a, b) => a.box.localeCompare(b.box)), [{ key: KEY_A, box: SPEAKER_BOX }, { key: KEY_A, box: POLL_BOX }])
    // Voting never touches the keys' rows.
    assert.deepEqual((await client.query('select id, xmin::text from credential order by id')).rows, xmins.rows)
  })
})

test('twenty parallel casts with one key in one contest stage exactly one ballot', DB, async (t) => {
  const s = await setup(t)
  const results = await Promise.all(Array.from({ length: 20 }, () => cast(s, KEY_B, SPEAKER_BOX, SPEAKER_CONTEST, RANKING)))
  assert.equal(results.filter((result) => result.cast).length, 1)
  assert.equal(results.filter((result) => !result.cast && result.reason === 'already-voted').length, 19)
  const { rows: [counts] } = await withClient(s.ownerUrl, (client) => client.query<{ staged: number, used: number }>(
    `select (select count(*)::int from ballot_box) as staged,
            (select count(*)::int from credential_entitlement where consumed and credential_id = $1) as used`,
    [s.credential[KEY_B]],
  ))
  assert.deepEqual(counts, { staged: 1, used: 1 })
})

test('what the database refuses comes back as refused, and the transaction stays usable', DB, async (t) => {
  const s = await setup(t)
  // Class 2B's batch replaced, past the trigger that keeps batches once the round is open.
  await withClient(s.ownerUrl, (client) => client.query(
    `begin; set local session_replication_role = replica; update credential_batch set state = 'void' where id = '${BATCH_2B}'; commit`,
  ))
  const afterRefusal = await s.db.tx(async (client) => {
    const result = await castBallot(client, { credentialId: s.credential[KEY_C] ?? '', roundContestId: SPEAKER_BOX, contest: SPEAKER_CONTEST, ballot: RANKING })
    const { rows } = await client.query<{ usable: number }>('select 1 as usable')
    return { result, usable: rows[0]?.usable }
  })
  assert.deepEqual(afterRefusal, { result: { cast: false, reason: 'refused' }, usable: 1 })

  assert.deepEqual(await cast(s, KEY_A, SPEAKER_BOX, SPEAKER_CONTEST, RANKING), { cast: true })
  await s.db.query('select seal_round($1)', [ROUND])
  assert.deepEqual(await cast(s, KEY_B, SPEAKER_BOX, SPEAKER_CONTEST, RANKING), { cast: false, reason: 'refused' })
  const { rows: [counts] } = await withClient(s.ownerUrl, (client) => client.query<{ staged: number, sealed: number, used: number }>(
    `select (select count(*)::int from ballot_box) as staged, (select count(*)::int from ballot) as sealed,
            (select count(*)::int from credential_entitlement where consumed) as used`,
  ))
  assert.deepEqual(counts, { staged: 0, sealed: 1, used: 1 })
})
