// delete_election: an election nobody used goes with everything of it;
// one that opened a round, ran a test or is final stays.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lockElection } from '../../lib/audit.ts'
import { SQLSTATE, sqlState } from '../../lib/pg-errors.ts'
import { openRound, startTest } from '../../lib/rounds.ts'
import { DB, withClient } from '../helpers/db.ts'
import { as, ELECTION, setup, type Setup } from '../helpers/representative-election.ts'

const TABLES = ['election', 'election_member', 'audit_event', 'contest', 'candidate', 'voter_group', 'voter_group_contest', 'round', 'round_contest', 'credential_batch', 'credential', 'credential_entitlement', 'ballot_box', 'ballot', 'result_snapshot']

async function rowsOf(s: Setup): Promise<Record<string, number>> {
  return withClient(s.ownerUrl, async (client) => {
    const counts: Record<string, number> = {}
    for (const table of TABLES) {
      const column = table === 'election' ? 'id' : 'election_id'
      counts[table] = (await client.query<{ n: number }>(`select count(*)::int as n from ${table} where ${column} = $1`, [ELECTION])).rows[0]?.n ?? 0
    }
    return counts
  })
}

const remove = (s: Setup) => s.db.query('select delete_election($1)', [ELECTION])

test('a prepared election with keys and a draft go wholly, audit log included', DB, async (t) => {
  const s = await setup(t)
  await withClient(s.ownerUrl, (client) => client.query(
    `insert into audit_event (election_id, at, actor_tid, actor_oid, actor_name, action, metadata, hash)
     values ($1, date_trunc('milliseconds', now()), gen_random_uuid(), gen_random_uuid(), 'Anna', 'election.created', '{}', repeat('a', 64))`,
    [ELECTION],
  ))
  const before = await rowsOf(s)
  assert.ok(before.credential_entitlement === 3 && before.audit_event === 1 && before.candidate === 2, JSON.stringify(before))
  await remove(s)
  assert.deepEqual(Object.values(await rowsOf(s)).every((n) => n === 0), true)
  await assert.rejects(remove(s), (err) => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState)
})

test('a draft goes too; an election whose round opened, is testing, or that is final stays', DB, async (t) => {
  const s = await setup(t)
  await withClient(s.ownerUrl, (client) => client.query(`update election set state = 'draft' where id = $1`, [ELECTION]))
  await remove(s)
  assert.equal((await rowsOf(s)).election, 0)

  const other = await setup(t)
  await other.db.tx(async (client) => {
    await lockElection(client, ELECTION)
    await startTest(client, await as(other))
  })
  await assert.rejects(other.db.query('select delete_election($1)', [ELECTION]), (err) => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState)
  await other.db.tx(async (client) => {
    await lockElection(client, ELECTION)
    await openRound(client, await as(other))
  })
  await assert.rejects(other.db.query('select delete_election($1)', [ELECTION]), (err) => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState)
  await withClient(other.ownerUrl, (client) => client.query(`begin; set local session_replication_role = replica; update round set state = 'closed'; update election set state = 'final' where id = '${ELECTION}'; commit`))
  await assert.rejects(other.db.query('select delete_election($1)', [ELECTION]), (err) => sqlState(err) === SQLSTATE.objectNotInPrerequisiteState)
  assert.equal((await rowsOf(other)).election, 1)
})

test('the runtime role deletes nothing of an election directly', DB, async (t) => {
  const s = await setup(t)
  // Members are the one exception: an invitation is withdrawn through the runtime role.
  for (const table of ['election', 'audit_event', 'round', 'credential_batch', 'credential']) {
    await assert.rejects(s.db.query(`delete from ${table}`), (err) => sqlState(err) === SQLSTATE.insufficientPrivilege, table)
  }
})
