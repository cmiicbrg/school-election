// A prepared election with one two-candidate contest (Klassensprecher/in,
// the representative ruleset), its planned regular round with one ballot
// box, and keys entitled to it, made as the owner past the API: what the
// tests of closing a round and of counting it start from. The ids are
// fixed, so a test can name rows.

import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { validateBallot, type CastBallot, type Contest } from '@school-election/election-core'
import { castBallot, type CastResult } from '../../lib/ballot-box.ts'
import { createDatabase, type Database } from '../../lib/db.ts'
import { Refusal, type ElectionAccess } from '../../lib/election-access.ts'
import type { ElectionRole } from '../../lib/permissions.ts'
import { createTestDatabase, withClient } from './db.ts'
import { accessAs } from './elections.ts'

export const ELECTION = '3f2b8c1e-5a4d-4e6f-9b7a-0c1d2e3f4a5b'
export const CONTEST = '5b4dae30-7c6f-4081-9d9c-2e3f4a5b6c7d'
export const GROUP = '7d6fc052-9e81-42a3-9fbe-4a5b6c7d8e9f'
export const ROUND = '8e7fd163-af92-43b4-8acf-5b6c7d8e9fa0'
export const BOX = '9f80e274-b0a3-44c5-9bd0-6c7d8e9fa0b1'
export const BATCH = 'a091f385-c1b4-45d6-8ce1-7d8e9fa0b1c2'
export const PAULA = 'c2b315a7-e3d6-47f8-8ea3-9fa0b1c2d3e4'
export const QUIRIN = 'd3c426b8-f4e7-4809-9fb4-a0b1c2d3e4f5'
export const CONTEST_OF: Contest = { id: CONTEST, rulesetId: 'at-representative-v1', candidateIds: [PAULA, QUIRIN] }
export const RUNOFF_BATCH = 'b1a2f496-d2c5-46e7-9df2-8e9fa0b1c2d3'
/** The runoff of the contest between its two candidates, as election-core sees it. */
export const RUNOFF_OF: Contest = { id: CONTEST, rulesetId: 'single-choice-v1', candidateIds: [PAULA, QUIRIN] }

export interface Setup {
  db: Database
  ownerUrl: string
  /** A second connection as the runtime role, for a statement that must run beside the pool's. */
  runtimeUrl: string
  credentialIds: string[]
}

/** The election, prepared, with `keys` keys entitled to its one box; the runtime database for the code under test. */
export async function setup(t: TestContext, keys = 3): Promise<Setup> {
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
  return { db, ownerUrl: testDb.ownerUrl, runtimeUrl: testDb.runtimeUrl, credentialIds: rows.map((row) => row.id) }
}

/** Opens the round as the owner, by the direct updates the API makes: for tests of what follows opening. */
export async function openDirectly(ownerUrl: string): Promise<void> {
  await withClient(ownerUrl, (client) => client.query(`update election set state = 'active' where id = '${ELECTION}'; update round set state = 'open' where id = '${ROUND}'`))
}

/** A complete ranking for the contest, validated. */
export function ranking(order: string[]): CastBallot {
  const result = validateBallot(CONTEST_OF, { kind: 'ranking', ranking: order })
  assert.ok(result.ok)
  return result.ballot
}

/** Casts a ballot with the key, in a transaction of its own, as the voter route will. */
export const cast = (s: Setup, credentialId: string, ballot = ranking([PAULA, QUIRIN])): Promise<CastResult> =>
  s.db.tx((client) => castBallot(client, { credentialId, roundContestId: BOX, contest: CONTEST_OF, ballot }))

/** What the route's guard would establish for a member in `role`, from the states as they are now. */
export const as = (s: Setup, role: ElectionRole = 'owner'): Promise<ElectionAccess> => accessAs(s.ownerUrl, ELECTION, role)

export const refusedWith = (statusCode: number, code: string) => (err: unknown): boolean =>
  err instanceof Refusal && err.statusCode === statusCode && err.code === code

/** Seals the regular round as the runtime role, as the close route does, without the count. */
export async function sealDirectly(s: Setup): Promise<void> {
  await s.db.query('select seal_round($1)', [ROUND])
}

/** A runoff batch of `keys` keys for the class, made as the owner past the API; its keys' credential ids in key order. */
export async function issueRunoffBatch(ownerUrl: string, keys = 2, batchId = RUNOFF_BATCH): Promise<string[]> {
  const prefix = batchId.slice(0, 4).toUpperCase().replaceAll(/[^0-9A-HJKMNP-TV-Z]/g, '0')
  return withClient(ownerUrl, async (client) => {
    await client.query(`insert into credential_batch (id, election_id, voter_group_id, round_kind) values ($1, $2, $3, 'runoff')`, [batchId, ELECTION, GROUP])
    await client.query(
      `insert into credential (election_id, batch_id, key) select $2, $1, $3 || lpad(n::text, 16, '0') from generate_series(1, $4::int) as n`,
      [batchId, ELECTION, prefix, keys],
    )
    const { rows } = await client.query<{ id: string }>('select id from credential where batch_id = $1 order by key', [batchId])
    return rows.map((row) => row.id)
  })
}

export interface Pair {
  contestId: string
  candidates: [string, string]
}

/** activate_runoff as the runtime role calls it; the runoff round's id. */
export async function activateDirectly(s: Setup, pairs: Pair[] = [{ contestId: CONTEST, candidates: [PAULA, QUIRIN] }]): Promise<string> {
  const { rows: [row] } = await s.db.query<{ activate_runoff: string }>('select activate_runoff($1, $2::jsonb)', [ELECTION, JSON.stringify(pairs)])
  return row?.activate_runoff ?? assert.fail('no runoff round')
}
