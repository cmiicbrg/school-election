// The credential tables as the runtime role meets them: a batch voided
// once, a key never changed, entitlements only for keys of an issued batch
// for their round, and their freeze once the round accepts ballots. When
// batches are issued and voided is the lifecycle's (packages/election-core).

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type pg from 'pg'
import { BATCH_STATES } from '../../lib/credentials.ts'
import { sqlState } from '../../lib/pg-errors.ts'
import { createTestDatabase, DB, withClient } from '../helpers/db.ts'

const ELECTION = '3f2b8c1e-5a4d-4e6f-9b7a-0c1d2e3f4a5b'
const CONTEST = '5b4dae30-7c6f-4081-9d9c-2e3f4a5b6c7d'
const GROUP = '7d6fc052-9e81-42a3-9fbe-4a5b6c7d8e9f'
const ROUND = '8e7fd163-af92-43b4-8acf-5b6c7d8e9fa0'
const BOX = '9f80e274-b0a3-44c5-9bd0-6c7d8e9fa0b1'
const BATCH = 'a091f385-c1b4-45d6-8ce1-7d8e9fa0b1c2'
const KEY_A = '00000000000000000000'
const KEY_B = '11111111111111111111'

/** A prepared election with one contest, one class, its planned round and ballot box, and an issued batch of two keys; made as the owner. */
async function setup(t: TestContext) {
  const db = await createTestDatabase(t)
  await withClient(db.ownerUrl, (client) => client.query(
    `insert into election (id, title) values ('${ELECTION}', 'Wahl');
     insert into contest (id, election_id, title, ruleset_id) values ('${CONTEST}', '${ELECTION}', 'Schulsprecher/in', 'at-school-speaker-v1');
     insert into candidate (election_id, contest_id, surname, given_name) values ('${ELECTION}', '${CONTEST}', 'Berger', 'Jonas');
     insert into voter_group (id, election_id, name) values ('${GROUP}', '${ELECTION}', '1A');
     insert into voter_group_contest (election_id, voter_group_id, contest_id) values ('${ELECTION}', '${GROUP}', '${CONTEST}');
     insert into round (id, election_id, kind) values ('${ROUND}', '${ELECTION}', 'regular');
     insert into round_contest (id, election_id, round_id, contest_id) values ('${BOX}', '${ELECTION}', '${ROUND}', '${CONTEST}');
     update election set state = 'prepared' where id = '${ELECTION}';
     insert into credential_batch (id, election_id, voter_group_id, round_kind) values ('${BATCH}', '${ELECTION}', '${GROUP}', 'regular');
     insert into credential (election_id, batch_id, key) values ('${ELECTION}', '${BATCH}', '${KEY_A}'), ('${ELECTION}', '${BATCH}', '${KEY_B}');`,
  ))
  return db
}

const refusedWith = (code: string) => (err: unknown) => sqlState(err) === code

async function refused(client: pg.Client, code: string, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await assert.rejects(client.query(statement), refusedWith(code), statement)
  }
}

const entitle = (key: string) => `insert into credential_entitlement (election_id, credential_id, round_contest_id)
  select election_id, id, '${BOX}' from credential where key = '${key}'`
const consume = (key: string, consumed = true) => `update credential_entitlement set consumed = ${consumed}
  where credential_id = (select id from credential where key = '${key}')`

/** Moves the election and its regular round on, as the owner, past the triggers: closing a round is the seal's. */
async function moveOn(ownerUrl: string, election: string, round: string): Promise<void> {
  await withClient(ownerUrl, (client) => client.query(
    `begin; set local session_replication_role = replica;
     update election set state = '${election}' where id = '${ELECTION}'; update round set state = '${round}' where id = '${ROUND}'; commit`,
  ))
}

test('a batch\'s state is one the code knows, only an issued batch is usable, and its round kind is a round\'s', DB, async (t) => {
  const { ownerUrl } = await setup(t)
  await withClient(ownerUrl, async (client) => {
    const { rows } = await client.query<{ state: string, usable: boolean }>('select state, usable from credential_batch_state order by state')
    assert.deepEqual(rows, [...BATCH_STATES].sort().map((state) => ({ state, usable: state !== 'void' })))
    const { rows: references } = await client.query<{ target: string }>(
      `select confrelid::regclass::text as target from pg_constraint where conrelid = 'credential_batch'::regclass and contype = 'f' order by 1`,
    )
    assert.deepEqual(references.map((row) => row.target), ['credential_batch_state', 'round_kind', 'voter_group'])
  })
})

test('entitlements freeze when their round opens: the runtime role only uses one up, while the round is open, and never restores it', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  await withClient(runtimeUrl, async (client) => {
    // Planned: added, but not used.
    await client.query(entitle(KEY_A))
    await refused(client, '55000', [
      consume(KEY_A),
      `insert into credential_entitlement (election_id, credential_id, round_contest_id, consumed)
       select election_id, id, '${BOX}', true from credential where key = '${KEY_B}'`,
    ])
  })
  await moveOn(ownerUrl, 'active', 'open')
  await withClient(runtimeUrl, async (client) => {
    await refused(client, '55000', [entitle(KEY_B)])
    await refused(client, '42501', [
      `delete from credential_entitlement`,
      `update credential_entitlement set round_contest_id = '${BOX}'`,
      `update credential set key = '${KEY_B}' where key = '${KEY_A}'`,
      `delete from credential`,
      `delete from credential_batch`,
    ])
    await client.query(consume(KEY_A))
    await refused(client, '55000', [consume(KEY_A, false)])
  })
  // A key of a void batch keeps its entitlement but never uses it up.
  await withClient(ownerUrl, (client) => client.query(
    `begin; set local session_replication_role = replica;
     ${entitle(KEY_B)}; update credential_batch set state = 'void' where id = '${BATCH}'; commit`,
  ))
  await withClient(runtimeUrl, (client) => refused(client, '55000', [consume(KEY_B)]))
  // The rules bind every direct statement, the owner's too.
  await withClient(ownerUrl, (client) => refused(client, '55000', [
    'delete from credential_entitlement',
    consume(KEY_A, false),
    `update credential set key = '${KEY_B}' where key = '${KEY_A}'`,
  ]))
  await moveOn(ownerUrl, 'active', 'closed')
  await withClient(runtimeUrl, (client) => refused(client, '55000', [entitle(KEY_B), consume(KEY_A, false)]))
  const { rows } = await withClient(ownerUrl, (client) => client.query<{ key: string, consumed: boolean }>(
    'select c.key, e.consumed from credential_entitlement e join credential c on c.id = e.credential_id',
  ))
  assert.deepEqual(rows.toSorted((a, b) => a.key.localeCompare(b.key)), [{ key: KEY_A, consumed: true }, { key: KEY_B, consumed: false }])
})

test('a function the migrations define as SECURITY DEFINER is not bound by the freeze, so the seal can rewrite a closed round\'s entitlements', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  await withClient(runtimeUrl, (client) => client.query(entitle(KEY_A)))
  await moveOn(ownerUrl, 'active', 'closed')
  // A stand-in: what such a function may do is its own rule.
  await withClient(ownerUrl, (client) => client.query(
    `create function rewrite_entitlements() returns void language sql security definer set search_path = pg_catalog as $$
       delete from public.credential_entitlement;
       insert into public.credential_entitlement (election_id, credential_id, round_contest_id, consumed)
       select election_id, id, '${BOX}', true from public.credential where key = '${KEY_A}';
     $$;
     grant execute on function rewrite_entitlements() to school_election_app`,
  ))
  await withClient(runtimeUrl, async (client) => {
    await refused(client, '42501', ['delete from credential_entitlement'])
    await client.query('select rewrite_entitlements()')
  })
  const { rows } = await withClient(ownerUrl, (client) => client.query<{ consumed: boolean }>('select consumed from credential_entitlement'))
  assert.deepEqual(rows, [{ consumed: true }])
})

test('a batch is voided once and a key never changes; an entitlement is for a key of an issued batch, never a runoff key\'s for a regular box', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  const issue = (kind: string) => `insert into credential_batch (election_id, voter_group_id, round_kind) values ('${ELECTION}', '${GROUP}', '${kind}')`
  await withClient(runtimeUrl, async (client) => {
    await client.query(issue('regular'))
    const { rows: [runoff] } = await client.query<{ id: string }>(`${issue('runoff')} returning id`)
    await client.query(`insert into credential (election_id, batch_id, key) values ('${ELECTION}', '${runoff?.id}', '33333333333333333333')`)
    // A runoff key has no entitlement for a regular ballot box.
    await refused(client, '55000', [entitle('33333333333333333333')])
    await refused(client, '42501', [`update credential_batch set voter_group_id = '${GROUP}'`, `update credential set key = '44444444444444444444'`])
    await client.query(`update credential_batch set state = 'void' where id = '${BATCH}'`)
    await refused(client, '55000', [
      `update credential_batch set state = 'issued' where id = '${BATCH}'`,
      `update credential_batch set state = 'void' where id = '${BATCH}'`,
      entitle(KEY_A),
    ])
  })
  // The owner's direct statements are bound the same way.
  await withClient(ownerUrl, (client) => refused(client, '55000', [
    `update credential_batch set state = 'issued' where id = '${BATCH}'`,
    `update credential_batch set round_kind = 'runoff' where id = '${BATCH}'`,
    `update credential set key = '44444444444444444444' where key = '${KEY_A}'`,
  ]))
})

test('removing a voter group removes its batches, keys and entitlements', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  await withClient(runtimeUrl, async (client) => {
    await client.query(entitle(KEY_A))
    // Back to draft first, as unpreparing does before a group can go: the lifecycle's order.
    await client.query(`update election set state = 'draft' where id = '${ELECTION}'`)
    await client.query(`delete from voter_group where id = '${GROUP}'`)
  })
  const { rows: [counts] } = await withClient(ownerUrl, (client) => client.query<{ batches: number, keys: number, entitlements: number }>(
    `select (select count(*) from credential_batch)::int as batches, (select count(*) from credential)::int as keys,
            (select count(*) from credential_entitlement)::int as entitlements`,
  ))
  assert.deepEqual(counts, { batches: 0, keys: 0, entitlements: 0 })
})
