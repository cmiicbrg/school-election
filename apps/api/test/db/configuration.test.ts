// The configuration tables as the runtime role meets them: the editing
// windows and the lifecycle kept by triggers, the links kept within one
// election, the privileges, and the values the code relies on.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type pg from 'pg'
import {
  canCastBallot,
  canEditCandidates,
  canEditStructure,
  canIssueBatch,
  canManageMembers,
  ELECTION_STATES,
  isConsistentLifecycle,
  LIFECYCLE_ACTIONS,
  NEW_ELECTION,
  ROUND_KINDS,
  ROUND_STATES,
  RULESET_IDS,
  transition,
  type Lifecycle,
  type RoundKind,
} from '@school-election/election-core'
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

test('the stored ruleset ids are exactly the ones the code knows', DB, async (t) => {
  const { ownerUrl } = await setup(t)
  assert.deepEqual(await checkedValues(ownerUrl, 'contest', 'ruleset_id'), [...RULESET_IDS])
})

/** Every combination of states the lifecycle allows. */
const LIFECYCLES: Lifecycle[] = ELECTION_STATES.flatMap((election) => ROUND_STATES.flatMap((regular) =>
  [null, ...ROUND_STATES].map((runoff) => ({ election, regular, runoff }) as Lifecycle))).filter(isConsistentLifecycle)

interface StateRows {
  election: { state: string, structure_editable: boolean, candidates_editable: boolean, final: boolean, advances_to: string | null, returns_to: string | null }[]
  kind: { kind: string, created_planned: boolean }[]
  round: { state: string, opened: boolean, accepts_ballots: boolean }[]
  transition: { from_state: string, to_state: string }[]
}

async function stateRows(url: string): Promise<StateRows> {
  return withClient(url, async (client) => ({
    election: (await client.query<StateRows['election'][number]>('select * from election_state order by state')).rows,
    kind: (await client.query<StateRows['kind'][number]>('select * from round_kind order by kind')).rows,
    round: (await client.query<StateRows['round'][number]>('select * from round_state order by state')).rows,
    transition: (await client.query<StateRows['transition'][number]>('select * from round_transition order by from_state, to_state')).rows,
  }))
}

function byKey<T>(rows: T[], key: (row: T) => string): Map<string, T> {
  return new Map(rows.map((row) => [key(row), row]))
}

test('the state tables say what the lifecycle in packages/election-core allows', DB, async (t) => {
  const { ownerUrl } = await setup(t)
  const rows = await stateRows(ownerUrl)
  assert.deepEqual(rows.election.map((row) => row.state), [...ELECTION_STATES].sort())
  assert.deepEqual(rows.kind.map((row) => row.kind), [...ROUND_KINDS].sort())
  assert.deepEqual(rows.round.map((row) => row.state), [...ROUND_STATES].sort())
  const electionState = byKey(rows.election, (row) => row.state)
  const roundState = byKey(rows.round, (row) => row.state)

  for (const lifecycle of LIFECYCLES) {
    const row = electionState.get(lifecycle.election)
    const label = JSON.stringify(lifecycle)
    assert.equal(row?.structure_editable, canEditStructure(lifecycle).ok, label)
    // The flag is the election's; a running test freezes candidates through the round (migration 0011).
    const candidates = canEditCandidates(lifecycle)
    if (candidates.ok || candidates.refusal !== 'round-testing') assert.equal(row?.candidates_editable, candidates.ok, label)
    assert.equal(row?.final, !canManageMembers(lifecycle).ok, label)
    for (const kind of ROUND_KINDS) {
      const state = kind === 'regular' ? lifecycle.regular : lifecycle.runoff
      if (state === null) continue
      assert.equal(roundState.get(state)?.accepts_ballots, canCastBallot(lifecycle, kind).ok, `${label} ${kind}`)
      // Keys for a round are issued until it opens, unless the election refuses them.
      const issue = canIssueBatch(lifecycle, kind)
      if (issue.ok || issue.refusal === 'voting-started') assert.equal(roundState.get(state)?.opened, !issue.ok, `${label} ${kind}`)
    }
  }
  for (const row of rows.kind) {
    assert.equal(row.created_planned, NEW_ELECTION[row.kind as RoundKind] === 'planned', row.kind)
  }

  // An election moves exactly along the lifecycle's transitions.
  const moves = new Set(LIFECYCLES.flatMap((lifecycle) => LIFECYCLE_ACTIONS.flatMap((action) => {
    const result = transition(lifecycle, action)
    return result.ok && result.next.election !== lifecycle.election ? [`${lifecycle.election} → ${result.next.election}`] : []
  })))
  const stored = rows.election.flatMap((row) => [row.advances_to, row.returns_to].flatMap((to) => to === null ? [] : [`${row.state} → ${to}`]))
  assert.deepEqual(stored.sort(), [...moves].sort())

  // And a round along the rows of round_transition (migration 0009). A
  // runoff round is created open, which is no transition.
  const roundMoves = new Set(LIFECYCLES.flatMap((lifecycle) => LIFECYCLE_ACTIONS.flatMap((action) => {
    const result = transition(lifecycle, action)
    if (!result.ok) return []
    return ROUND_KINDS.flatMap((kind) => {
      const from = kind === 'regular' ? lifecycle.regular : lifecycle.runoff
      const to = kind === 'regular' ? result.next.regular : result.next.runoff
      return from !== null && to !== null && from !== to ? [`${from} → ${to}`] : []
    })
  })))
  assert.deepEqual(rows.transition.map((row) => `${row.from_state} → ${row.to_state}`).sort(), [...roundMoves].sort())
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
  // Final: made past the triggers, since the step to final needs a sealed
  // round and the declared outcomes (migration 0014, test/db/finalize.test.ts),
  // to test this window on its own.
  await withClient(ownerUrl, (client) => client.query(
    `begin; set local session_replication_role = replica; update election set state = 'final' where id = '${A}'; commit`,
  ))
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
  // A round that has opened while the election is still prepared, which
  // the round's own trigger (migration 0009) refuses: made past the
  // triggers, to test this one's rule on its own.
  await withClient(ownerUrl, (client) => client.query(
    `begin; set local session_replication_role = replica; update round set state = 'open' where election_id = '${A}'; commit`,
  ))
  await withClient(runtimeUrl, (client) => refused(client, '55000', [`update election set state = 'draft' where id = '${A}'`]))
})

test('rounds start planned before voting, and their ballot boxes change only while they are planned', DB, async (t) => {
  const { runtimeUrl } = await setup(t)
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
    // The runtime role opens the round of an active election
    // (test/db/ballot-box.test.ts has the rest of its transitions), and
    // removes none.
    await refused(client, '42501', [`delete from round`, `update round_contest set contest_id = contest_id`])
    await client.query(`update election set state = 'active' where id = '${A}'; update round set state = 'open' where election_id = '${A}'`)
    await refused(client, '55000', [`delete from round_contest where election_id = '${A}'`])
  })
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
