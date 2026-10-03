// The configuration tables as the runtime role meets them: the editing
// windows and the lifecycle kept by triggers, the links kept within one
// election, the privileges, and the values the code relies on.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type pg from 'pg'
import { RULESET_IDS, ROUND_KINDS, ROUND_STATES } from '@school-election/election-core'
import { sqlState } from '../../lib/pg-errors.ts'
import { checkedValues, createTestDatabase, DB, withClient } from '../helpers/db.ts'

const A = '3f2b8c1e-5a4d-4e6f-9b7a-0c1d2e3f4a5b'
const B = '4a3c9d2f-6b5e-4f70-8c8b-1d2e3f4a5b6c'
const CONTEST_A = '5b4dae30-7c6f-4081-9d9c-2e3f4a5b6c7d'
const CONTEST_B = '6c5ebf41-8d70-4192-8ead-3f4a5b6c7d8e'
const GROUP_A = '7d6fc052-9e81-42a3-9fbe-4a5b6c7d8e9f'

/** Two draft elections, each with a contest, and a voter group in the first; made as the owner. */
async function setup(t: TestContext) {
  const db = await createTestDatabase(t)
  await withClient(db.ownerUrl, (client) => client.query(
    `insert into election (id, title) values ('${A}', 'A'), ('${B}', 'B');
     insert into contest (id, election_id, title, ruleset_id) values
       ('${CONTEST_A}', '${A}', 'Schulsprecher/in', 'at-school-speaker-v1'), ('${CONTEST_B}', '${B}', 'Abstimmung', 'single-choice-v1');
     insert into voter_group (id, election_id, name) values ('${GROUP_A}', '${A}', '1A');`,
  ))
  return db
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const refusedWith = (code: string) => (err: unknown) => sqlState(err) === code

/** Runs statements as the runtime role, each expected to be refused with `code`. */
async function refused(client: pg.Client, code: string, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await assert.rejects(client.query(statement), refusedWith(code), statement)
  }
}

test('the stored kinds, states and ruleset ids are exactly the ones the code knows', DB, async (t) => {
  const { ownerUrl } = await setup(t)
  assert.deepEqual(await checkedValues(ownerUrl, 'round', 'kind'), [...ROUND_KINDS])
  assert.deepEqual(await checkedValues(ownerUrl, 'round', 'state'), [...ROUND_STATES])
  assert.deepEqual(await checkedValues(ownerUrl, 'contest', 'ruleset_id'), [...RULESET_IDS])
})

test('no table numbers its rows by a sequence or a time-ordered id; the audit log alone has its sequence', DB, async (t) => {
  const { ownerUrl } = await setup(t)
  const { rows } = await withClient(ownerUrl, (client) => client.query<{ column: string }>(
    `select table_name || '.' || column_name as column from information_schema.columns
      where table_schema = 'public' and table_name <> 'schema_migrations'
        and (is_identity = 'YES' or column_default like '%nextval%' or column_default like '%uuidv7%')
      order by 1`,
  ))
  assert.deepEqual(rows.map((row) => row.column), ['audit_event.seq'])
})

test('structure changes only in a draft, candidates until voting starts, and nothing once final', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  await withClient(runtimeUrl, async (client) => {
    // A draft takes everything.
    await client.query(`insert into contest (election_id, title, ruleset_id) values ('${A}', 'Klassensprecher/in 1A', 'at-representative-v1')`)
    await client.query(`insert into voter_group_contest (election_id, voter_group_id, contest_id) values ('${A}', '${GROUP_A}', '${CONTEST_A}')`)
    await client.query(`insert into candidate (election_id, contest_id, surname, given_name) values ('${A}', '${CONTEST_A}', 'Berger', 'Jonas')`)

    await client.query(`update election set state = 'prepared' where id = '${A}'`)
    await refused(client, '55000', [
      `insert into contest (election_id, title, ruleset_id) values ('${A}', 'Abteilungssprecher/in', 'at-representative-v1')`,
      `update contest set title = 'Schulsprecher' where id = '${CONTEST_A}'`,
      `delete from contest where id = '${CONTEST_A}'`,
      `insert into voter_group (election_id, name) values ('${A}', '2B')`,
      `update voter_group set name = '1a' where id = '${GROUP_A}'`,
      `delete from voter_group where id = '${GROUP_A}'`,
      `delete from voter_group_contest where voter_group_id = '${GROUP_A}'`,
    ])
    // Candidates, title and description still change.
    await client.query(`insert into candidate (election_id, contest_id, surname, given_name) values ('${A}', '${CONTEST_A}', 'Huber', 'Lena')`)
    await client.query(`update candidate set given_name = 'Jonas Maria' where surname = 'Berger'`)
    await client.query(`delete from candidate where surname = 'Huber'`)
    // The last candidate of a prepared contest stays.
    await refused(client, '55000', [`delete from candidate where surname = 'Berger'`])
    await client.query(`update election set title = 'A 2026/27', description = 'Neu' where id = '${A}'`)
    // Another election's draft is not affected.
    await client.query(`insert into voter_group (election_id, name) values ('${B}', '1A')`)
  })

  // Voting has started: as the round-opening route will do it, past the
  // routes this version has.
  await withClient(ownerUrl, (client) => client.query(`update election set state = 'active' where id = '${A}'`))
  await withClient(runtimeUrl, (client) => refused(client, '55000', [
    `insert into candidate (election_id, contest_id, surname, given_name) values ('${A}', '${CONTEST_A}', 'Huber', 'Lena')`,
    `update candidate set surname = 'Bergér' where surname = 'Berger'`,
    `delete from candidate where surname = 'Berger'`,
    `update election set title = 'Später' where id = '${A}'`,
    `update election set description = 'Später' where id = '${A}'`,
  ]))
  await withClient(ownerUrl, (client) => client.query(`update election set state = 'final' where id = '${A}'`))
  await withClient(runtimeUrl, (client) => refused(client, '55000', [
    `update election set state = 'active' where id = '${A}'`,
    `update election set state = 'final' where id = '${A}'`,
    `update election set title = title where id = '${A}'`,
  ]))
})

test('an election moves only along the lifecycle, and back to draft only while no round has opened', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  await withClient(runtimeUrl, async (client) => {
    await refused(client, '55000', [
      `update election set state = 'active' where id = '${A}'`,
      `update election set state = 'final' where id = '${A}'`,
    ])
    await client.query(`update election set state = 'prepared' where id = '${A}'`)
    await client.query(`insert into round (election_id, kind) values ('${A}', 'regular')`)
    await client.query(`update election set state = 'draft' where id = '${A}'`)
    await client.query(`update election set state = 'prepared' where id = '${A}'`)
  })
  // A round that has opened, which only the owner can make here.
  await withClient(ownerUrl, (client) => client.query(`update round set state = 'open' where election_id = '${A}'`))
  await withClient(runtimeUrl, (client) => refused(client, '55000', [`update election set state = 'draft' where id = '${A}'`]))
})

test('rounds start planned before voting, and their ballot boxes change only while they are planned', DB, async (t) => {
  const { ownerUrl, runtimeUrl } = await setup(t)
  await withClient(runtimeUrl, async (client) => {
    await refused(client, '55000', [
      `insert into round (election_id, kind) values ('${A}', 'runoff')`,
      `insert into round (election_id, kind, state) values ('${A}', 'regular', 'open')`,
    ])
    await client.query(`insert into round (election_id, kind) values ('${A}', 'regular')`)
    await refused(client, '23505', [`insert into round (election_id, kind) values ('${A}', 'regular')`])
    await client.query(`insert into round_contest (election_id, round_id, contest_id) select '${A}', id, '${CONTEST_A}' from round where election_id = '${A}'`)
    // A contest removed in the draft takes its ballot box with it.
    await client.query(`delete from contest where id = '${CONTEST_A}'`)
    assert.equal((await client.query('select 1 from round_contest')).rowCount, 0)
    await client.query(`insert into contest (id, election_id, title, ruleset_id) values ('${CONTEST_A}', '${A}', 'Schulsprecher/in', 'at-school-speaker-v1')`)
    await client.query(`insert into round_contest (election_id, round_id, contest_id) select '${A}', id, '${CONTEST_A}' from round where election_id = '${A}'`)
    await client.query(`update election set state = 'prepared' where id = '${A}'`)
    // The runtime role has no say over a round's state, nor removes one.
    await refused(client, '42501', [`update round set state = 'open'`, `delete from round`, `update round_contest set contest_id = contest_id`])
  })
  await withClient(ownerUrl, (client) => client.query(`update round set state = 'open' where election_id = '${A}'`))
  await withClient(runtimeUrl, (client) => refused(client, '55000', [`delete from round_contest where election_id = '${A}'`]))
})

test('everything joins within one election: no mapping, candidate or ballot box across two', DB, async (t) => {
  const { runtimeUrl } = await setup(t)
  await withClient(runtimeUrl, async (client) => {
    await client.query(`insert into round (election_id, kind) values ('${B}', 'regular')`)
    await refused(client, '23503', [
      `insert into voter_group_contest (election_id, voter_group_id, contest_id) values ('${A}', '${GROUP_A}', '${CONTEST_B}')`,
      `insert into voter_group_contest (election_id, voter_group_id, contest_id) values ('${B}', '${GROUP_A}', '${CONTEST_B}')`,
      `insert into candidate (election_id, contest_id, surname, given_name) values ('${A}', '${CONTEST_B}', 'Ja', '')`,
      `insert into round_contest (election_id, round_id, contest_id) select '${A}', id, '${CONTEST_A}' from round where election_id = '${B}'`,
    ])
    // Columns that would move a row elsewhere are not the runtime role's to change.
    await refused(client, '42501', [
      `update candidate set contest_id = '${CONTEST_B}'`,
      `update contest set election_id = '${B}'`,
      `update voter_group set election_id = '${B}'`,
      `update voter_group_contest set contest_id = '${CONTEST_B}'`,
    ])
  })
})

test('a candidate\'s picture is a WebP of at most 128 KiB, stored with its SHA-256', DB, async (t) => {
  const { runtimeUrl } = await setup(t)
  const webp = Buffer.from('524946463800000057454250565038202c000000d001009d012a0800080001402225a00274ba01f80003b000fef1dc8ffcf4cd7983fc9cffe4172c2eb6940000', 'hex')
  const sha = '2f84977c6731a3c9967ba9664b3e50091520a8c0403d57ee0673d496bb164295'
  const insert = `insert into candidate (election_id, contest_id, surname, given_name, picture, picture_sha256) values ('${A}', '${CONTEST_A}', $1, '', $2, $3)`
  await withClient(runtimeUrl, async (client) => {
    await client.query(insert, ['Berger', webp, sha])
    const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex')
    const large = Buffer.concat([webp, Buffer.alloc(128 * 1024)])
    const refusedRows: [string, Buffer | null, string | null][] = [
      ['a hash of other bytes', webp, 'a'.repeat(64)],
      ['a picture without its hash', webp, null],
      ['a hash without a picture', null, sha],
      ['a JPEG', jpeg, sha256(jpeg)],
      ['more than 128 KiB', large, sha256(large)],
    ]
    for (const [label, picture, hash] of refusedRows) {
      await assert.rejects(client.query(insert, [label, picture, hash]), refusedWith('23514'), label)
    }
  })
})

test('a state change waits for a configuration change to commit, and the other way round', DB, async (t) => {
  const { runtimeUrl } = await setup(t)
  await withClient(runtimeUrl, async (editing) => {
    await editing.query('begin')
    await editing.query(`insert into candidate (election_id, contest_id, surname, given_name) values ('${A}', '${CONTEST_A}', 'Berger', 'Jonas')`)
    await withClient(runtimeUrl, async (preparing) => {
      await preparing.query('set lock_timeout = 200')
      await assert.rejects(preparing.query(`update election set state = 'prepared' where id = '${A}'`), refusedWith('55P03'))
    })
    await editing.query('commit')
  })
  await withClient(runtimeUrl, async (preparing) => {
    await preparing.query('begin')
    await preparing.query(`update election set state = 'prepared' where id = '${A}'`)
    await withClient(runtimeUrl, async (editing) => {
      await editing.query('set lock_timeout = 200')
      await assert.rejects(editing.query(`insert into voter_group (election_id, name) values ('${A}', '2B')`), refusedWith('55P03'))
    })
    await preparing.query('rollback')
  })
})
