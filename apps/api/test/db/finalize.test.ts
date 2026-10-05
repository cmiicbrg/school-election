// Finalization at the database level (migration 0014): a declaration
// comes to be only through finalize_election, on an active election,
// naming every contest once, and makes the election final in the same
// step; a declared outcome never changes, for any role; once final, the
// election, its lots and its outcomes do not change; and the runtime role
// holds exactly the rights the clean-up and the declaration need. That the
// regular round has closed and no round is open is the lifecycle's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sqlState } from '../../lib/pg-errors.ts'
import { DB, withClient } from '../helpers/db.ts'
import { BOX, cast, CONTEST, ELECTION, openDirectly, PAULA, QUIRIN, sealDirectly, setup } from '../helpers/representative-election.ts'

const OUTCOME = { kind: 'final', positions: [], trace: [] }
const declaration = (contestId = CONTEST, outcome: unknown = OUTCOME) => JSON.stringify([{ contestId, outcome }])
const refused = (err: unknown): boolean => sqlState(err) === '55000'

test('a declaration comes only through finalize_election, on an active election, naming every contest once, and makes the election final; a declared outcome and a final election never change', DB, async (t) => {
  const s = await setup(t)
  const finalize = (outcomes = declaration()) => s.db.query('select finalize_election($1, $2::jsonb, 2, $3, $4) as declared', [ELECTION, outcomes, 'dev', 'unknown'])
  const insert = `insert into final_outcome (election_id, contest_id, kind, outcome, tally_version, app_version, git_sha) values ($1, $2, 'final', $3::jsonb, 2, 'dev', 'unknown')`
  // Prepared: not active, and the runtime role has no way to the table but the function.
  await assert.rejects(finalize(), refused)
  await assert.rejects(s.db.query(insert, [ELECTION, CONTEST, JSON.stringify(OUTCOME)]), (err) => sqlState(err) === '42501')
  await withClient(s.ownerUrl, (client) => assert.rejects(client.query(`update election set state = 'final' where id = $1`, [ELECTION]), refused, 'no outcome written'))
  await openDirectly(s.ownerUrl)
  assert.deepEqual(await cast(s, s.credentialIds[0] ?? ''), { cast: true })
  await sealDirectly(s)
  // Closed: the declaration names every contest of the election, once, with its own kind.
  await assert.rejects(finalize('[]'), refused)
  await assert.rejects(finalize('{}'), refused)
  await assert.rejects(finalize(declaration('00000000-0000-4000-8000-000000000000')), refused)
  await assert.rejects(finalize(JSON.stringify([{ contestId: CONTEST, outcome: OUTCOME }, { contestId: CONTEST, outcome: OUTCOME }])), refused)
  await assert.rejects(finalize(declaration(CONTEST, { kind: 'bogus' })), (err) => sqlState(err) === '23514', 'the kind is the outcome\'s, one election-core knows')
  await assert.rejects(finalize(declaration(CONTEST, {})), (err) => sqlState(err) === '23502', 'an outcome has a kind')
  // The owner's step to final without a declaration is refused by the trigger.
  await withClient(s.ownerUrl, (client) => assert.rejects(client.query(`update election set state = 'final' where id = $1`, [ELECTION]), refused))
  const { rows: [done] } = await finalize()
  assert.equal(done?.declared, 1)
  const { rows: [election] } = await s.db.query<{ state: string }>('select state from election where id = $1', [ELECTION])
  assert.equal(election?.state, 'final')
  const { rows: outcomes } = await s.db.query<{ contest_id: string, kind: string, tally_version: number }>('select contest_id, kind, tally_version from final_outcome where election_id = $1', [ELECTION])
  assert.deepEqual(outcomes, [{ contest_id: CONTEST, kind: 'final', tally_version: 2 }])

  // Final: a second declaration, a lot, the title, the state, the outcomes: nothing of it changes, for any role.
  await assert.rejects(finalize(), refused)
  await assert.rejects(s.db.query(
    `insert into lot_decision (election_id, round_contest_id, lot_id, candidates, drawn, reason, actor_tid, actor_oid, actor_name)
     values ($1, $2, 'positions:deputy', $3::uuid[], $4::uuid[], 'nachträglich', gen_random_uuid(), gen_random_uuid(), 'X')`,
    [ELECTION, BOX, [PAULA, QUIRIN], [QUIRIN, PAULA]],
  ), refused)
  await assert.rejects(s.db.query(`update election set title = 'Anders' where id = $1`, [ELECTION]), refused)
  await withClient(s.ownerUrl, async (client) => {
    await assert.rejects(client.query(`update final_outcome set kind = 'tie', outcome = '{"kind":"tie","candidates":[],"trace":[]}' where contest_id = $1`, [CONTEST]), refused)
    await assert.rejects(client.query('delete from final_outcome'), refused)
    await assert.rejects(client.query(`update election set state = 'active' where id = $1`, [ELECTION]), refused)
  })
})

test('the runtime role may rewrite the two tables with dead rows of the votes, run the clean-up functions and the declaration, read declared outcomes, and nothing of the catalog\'s own', DB, async (t) => {
  const s = await setup(t)
  const { rows: [rights] } = await withClient(s.ownerUrl, (client) => client.query<Record<string, boolean>>(
    `select has_table_privilege('school_election_app', 'ballot_box', 'MAINTAIN') as ballot_box,
            has_table_privilege('school_election_app', 'credential_entitlement', 'MAINTAIN') as credential_entitlement,
            has_table_privilege('school_election_app', 'ballot', 'MAINTAIN') as ballot,
            has_table_privilege('school_election_app', 'credential', 'MAINTAIN') as credential,
            has_table_privilege('school_election_app', 'final_outcome', 'SELECT') as read_outcomes,
            has_table_privilege('school_election_app', 'final_outcome', 'INSERT') as write_outcomes,
            has_function_privilege('school_election_app', 'cleanup_blockers(uuid)', 'EXECUTE') as blockers,
            has_function_privilege('school_election_app', 'flush_wal(pg_lsn)', 'EXECUTE') as flush,
            has_function_privilege('school_election_app', 'finalize_election(uuid,jsonb,integer,text,text)', 'EXECUTE') as finalize,
            has_function_privilege('school_election_app', 'pg_switch_wal()', 'EXECUTE') as switch_wal,
            has_function_privilege('school_election_app', 'pg_ls_waldir()', 'EXECUTE') as ls_waldir,
            pg_has_role('school_election_app', 'pg_checkpoint', 'MEMBER') as checkpoint`,
  ))
  assert.deepEqual(rights, {
    ballot_box: true, credential_entitlement: true, ballot: false, credential: false, read_outcomes: true, write_outcomes: false,
    blockers: true, flush: true, finalize: true, switch_wal: false, ls_waldir: false, checkpoint: false,
  })
  await s.db.query('vacuum full ballot_box')
  await assert.rejects(s.db.query('checkpoint'), (err) => sqlState(err) === '42501')
  await assert.rejects(s.db.query('select pg_switch_wal()'), (err) => sqlState(err) === '42501')
})
