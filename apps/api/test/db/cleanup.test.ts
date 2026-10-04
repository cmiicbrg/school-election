// The clean-up after an election (lib/cleanup.ts): what the seal leaves in
// the data directory, read with pageinspect and pg_walinspect as the
// owner; that the clean-up removes it, keeps the seal's order and changes
// no result; that a snapshot older than the seal holds the dead rows back,
// is counted, waited for and refused; and the flush of the write-ahead log.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { lockElection } from '../../lib/audit.ts'
import { cleanUp, cleanupBlockers } from '../../lib/cleanup.ts'
import { createDatabase, type Database } from '../../lib/db.ts'
import { buildExport } from '../../lib/export.ts'
import { closeAndTally } from '../../lib/rounds.ts'
import { createTestDatabase, DB, withClient } from '../helpers/db.ts'
import { accessAs } from '../helpers/elections.ts'
import { assertUnlinkable, castBallotCaster, installInspection, plannedRunoffVotes, runoffScenario, seedPrivacyScenario, voteInterleaved, voteTraces, type PrivacyScenario } from '../helpers/privacy.ts'
import { refusedWith } from '../helpers/representative-election.ts'

const BUILD = { version: 'dev', gitSha: 'unknown' }

interface Sealed {
  scenario: PrivacyScenario
  db: Database
}

/** The three-contest scenario, voted and closed through the production path, with the inspection extensions installed. */
async function sealedScenario(t: TestContext): Promise<Sealed> {
  const scenario = await seedPrivacyScenario(t)
  await installInspection(scenario.ownerUrl)
  const db = createDatabase(scenario.runtimeUrl, () => {})
  t.after(() => db.close())
  await voteInterleaved(scenario, castBallotCaster(db, scenario))
  await closeThrough(db, scenario, 'regular')
  return { scenario, db }
}

async function closeThrough(db: Database, scenario: PrivacyScenario, kind: 'regular' | 'runoff'): Promise<void> {
  const access = await accessAs(scenario.ownerUrl, scenario.electionId, 'owner')
  await db.tx(async (client) => {
    await lockElection(client, scenario.electionId)
    return closeAndTally(client, access, BUILD, kind)
  })
}

/** A session holding a snapshot from now on, as a dump or a long read does; ended by `end`. */
async function reader(url: string, t: TestContext): Promise<{ end: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  await client.query('begin isolation level repeatable read')
  await client.query('select count(*) from election')
  let ended = false
  const end = async (): Promise<void> => {
    if (ended) return
    ended = true
    await client.query('commit')
    await client.end()
  }
  t.after(end)
  return { end }
}

test('the seal leaves the votes in dead rows and in the write-ahead log; the clean-up removes both, keeps the seal\'s order and changes no result', DB, async (t) => {
  const { scenario, db } = await sealedScenario(t)
  // Right after the seal, before anything scans the tables: the staged
  // ballots the seal deleted and the entitlement versions it replaced
  // still lie in the pages, each with its vote's transaction id, and the
  // votes' records in the write-ahead log.
  const before = await voteTraces(scenario)
  assert.ok(before.tuples >= scenario.castOrder.length * 2, `${before.tuples} tuples carry a vote's transaction id`)
  assert.ok(before.records >= scenario.castOrder.length, `${before.records} records of the write-ahead log on disk are the votes'`)
  await assertUnlinkable(scenario)
  const exported = await db.tx((client) => buildExport(client, scenario.electionId, BUILD))

  const phases = await cleanUp(db, scenario.electionId)
  assert.deepEqual(Object.keys(phases), ['regular'])
  assert.deepEqual(await voteTraces(scenario), { tuples: 0, records: 0 })
  await assertUnlinkable(scenario)
  const again = await db.tx((client) => buildExport(client, scenario.electionId, BUILD))
  assert.deepEqual(
    [again.document.rounds, again.document.snapshots, again.document.outcomes],
    [exported.document.rounds, exported.document.snapshots, exported.document.outcomes],
  )
  // Once more: nothing left to remove, and the same answer.
  assert.deepEqual(await cleanUp(db, scenario.electionId), phases)
})

test('and after the runoff: both seals\' leftovers are gone, the first round\'s included', DB, async (t) => {
  const { scenario, db } = await sealedScenario(t)
  const runoff = await runoffScenario(scenario, db)
  await voteInterleaved(runoff, castBallotCaster(db, runoff), 2027, plannedRunoffVotes)
  await closeThrough(db, scenario, 'runoff')
  const both: PrivacyScenario = { ...runoff, voteXids: new Set([...scenario.voteXids, ...runoff.voteXids]) }
  const before = await voteTraces(both)
  assert.ok(before.tuples >= runoff.castOrder.length * 2, `${before.tuples} tuples carry a runoff vote's transaction id`)

  const phases = await cleanUp(db, scenario.electionId)
  assert.deepEqual(Object.keys(phases).sort(), ['regular', 'runoff'])
  assert.deepEqual(await voteTraces(both), { tuples: 0, records: 0 })
  await assertUnlinkable(runoff)
  scenario.credentialXmins = runoff.credentialXmins
  await assertUnlinkable(scenario)
})

test('a snapshot older than the seal holds the dead rows back: counted as a blocker, a rewrite under it keeps them, the clean-up waits and refuses, and succeeds once it ends; one taken after the seal counts for nothing', DB, async (t) => {
  const scenario = await seedPrivacyScenario(t)
  await installInspection(scenario.ownerUrl)
  const db = createDatabase(scenario.runtimeUrl, () => {})
  t.after(() => db.close())
  await voteInterleaved(scenario, castBallotCaster(db, scenario))
  const older = await reader(scenario.ownerUrl, t)
  await closeThrough(db, scenario, 'regular')
  assert.equal(await cleanupBlockers(db, scenario.electionId), 1)
  // A rewrite regardless keeps every row the older snapshot could still see.
  await db.query('vacuum full ballot_box')
  await db.query('vacuum full credential_entitlement')
  assert.ok((await voteTraces(scenario)).tuples > 0, 'the rewrite under an older snapshot keeps the dead rows')
  const started = Date.now()
  await assert.rejects(cleanUp(db, scenario.electionId, { waitMs: 600, pollMs: 100 }), refusedWith(409, 'cleanup_blocked'))
  assert.ok(Date.now() - started >= 500, 'the clean-up waited before it refused')

  const newer = await reader(scenario.runtimeUrl, t)
  await older.end()
  assert.equal(await cleanupBlockers(db, scenario.electionId), 0, 'a snapshot taken after the seal sees nothing the seal removed')
  await cleanUp(db, scenario.electionId)
  assert.deepEqual(await voteTraces(scenario), { tuples: 0, records: 0 })
  await newer.end()
})

test('flush_wal leaves no segment at or before the position given, and an election without a sealed row has no blockers', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  const { rows: [position] } = await db.query<{ lsn: string }>('select pg_current_wal_lsn()::text as lsn')
  const { rows: [flushed] } = await db.query<{ cleared: boolean }>('select flush_wal($1::pg_lsn) as cleared', [position?.lsn])
  assert.equal(flushed?.cleared, true)
  await withClient(testDb.ownerUrl, async (client) => {
    const { rows: [segments] } = await client.query<{ total: number, old: number }>(
      `select count(*)::int as total, count(*) filter (where w.name <= pg_walfile_name($1::pg_lsn))::int as old
         from pg_ls_waldir() as w where w.name ~ '^[0-9A-F]{24}$'`,
      [position?.lsn],
    )
    assert.equal(segments?.old, 0)
    assert.ok((segments?.total ?? 0) >= 1 && (segments?.total ?? 0) <= 2, `${segments?.total} segments on disk`)
  })
  assert.equal(await cleanupBlockers(db, '00000000-0000-4000-8000-000000000000'), 0)
})
