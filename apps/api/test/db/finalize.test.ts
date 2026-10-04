// Finalization at the database level (migration 0014): a final outcome is
// written on an active election once its regular round has closed and
// while no round accepts ballots, once per contest, and never changes; an
// election is final only then, with every contest's final outcome, and
// never changes afterwards; and the runtime role holds exactly the rights
// the clean-up needs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sqlState } from '../../lib/pg-errors.ts'
import { DB, withClient } from '../helpers/db.ts'
import { cast, CONTEST, ELECTION, openDirectly, sealDirectly, setup } from '../helpers/representative-election.ts'

const OUTCOME = JSON.stringify({ kind: 'final', positions: [], trace: [] })
const INSERT = `insert into final_outcome (election_id, contest_id, kind, outcome, tally_version, app_version, git_sha) values ($1, $2, $3, $4::jsonb, 2, 'dev', 'unknown')`
const refused = (err: unknown): boolean => sqlState(err) === '55000'

test('a final outcome is written once the regular round has closed and nothing accepts ballots, once per contest, and never changes; the election is final only with every contest\'s', DB, async (t) => {
  const s = await setup(t)
  const write = (kind = 'final', outcome = OUTCOME) => s.db.query(INSERT, [ELECTION, CONTEST, kind, outcome])
  const finalize = () => s.db.query(`update election set state = 'final' where id = $1`, [ELECTION])
  // Prepared, the round planned: neither the outcome nor the state.
  await assert.rejects(write(), refused)
  await assert.rejects(finalize(), (err) => sqlState(err) === '55000' || sqlState(err) === '23514')
  await openDirectly(s.ownerUrl)
  assert.deepEqual(await cast(s, s.credentialIds[0] ?? ''), { cast: true })
  // Open: the round accepts ballots.
  await assert.rejects(write(), refused)
  await assert.rejects(finalize(), refused)
  await sealDirectly(s)
  // Closed, but no final outcome yet: the election is not final.
  await assert.rejects(finalize(), refused)
  await assert.rejects(write('tie'), (err) => sqlState(err) === '23514', 'the kind is the outcome\'s')
  await assert.rejects(write('final', '{"kind":"final"'), (err) => sqlState(err) === '22P02')
  await write()
  await assert.rejects(write(), (err) => sqlState(err) === '23505', 'once per contest')
  await withClient(s.ownerUrl, async (client) => {
    await assert.rejects(client.query(`update final_outcome set kind = 'tie', outcome = '{"kind":"tie","candidates":[],"trace":[]}' where contest_id = $1`, [CONTEST]), refused)
    await assert.rejects(client.query('delete from final_outcome'), refused)
  })
  await finalize()
  const { rows: [election] } = await s.db.query<{ state: string }>('select state from election where id = $1', [ELECTION])
  assert.equal(election?.state, 'final')
  // Final: nothing of it changes, for any role.
  await assert.rejects(s.db.query(`update election set title = 'Anders' where id = $1`, [ELECTION]), refused)
  await assert.rejects(s.db.query(`update credential_batch set state = 'void' where election_id = $1`, [ELECTION]), refused)
  await withClient(s.ownerUrl, async (client) => {
    await assert.rejects(client.query(`update election set state = 'active' where id = $1`, [ELECTION]), refused)
    await assert.rejects(client.query('delete from final_outcome'), refused)
    await assert.rejects(client.query(`insert into round (election_id, kind, state) values ($1, 'runoff', 'open')`, [ELECTION]), refused)
  })
})

test('the runtime role may rewrite the two tables with dead rows of the votes, run the two clean-up functions, and nothing of the catalog\'s own', DB, async (t) => {
  const s = await setup(t)
  const { rows: [rights] } = await withClient(s.ownerUrl, (client) => client.query<Record<string, boolean>>(
    `select has_table_privilege('school_election_app', 'ballot_box', 'MAINTAIN') as ballot_box,
            has_table_privilege('school_election_app', 'credential_entitlement', 'MAINTAIN') as credential_entitlement,
            has_table_privilege('school_election_app', 'ballot', 'MAINTAIN') as ballot,
            has_table_privilege('school_election_app', 'credential', 'MAINTAIN') as credential,
            has_function_privilege('school_election_app', 'cleanup_blockers(uuid)', 'EXECUTE') as blockers,
            has_function_privilege('school_election_app', 'flush_wal(pg_lsn)', 'EXECUTE') as flush,
            has_function_privilege('school_election_app', 'pg_switch_wal()', 'EXECUTE') as switch_wal,
            has_function_privilege('school_election_app', 'pg_ls_waldir()', 'EXECUTE') as ls_waldir,
            pg_has_role('school_election_app', 'pg_checkpoint', 'MEMBER') as checkpoint`,
  ))
  assert.deepEqual(rights, { ballot_box: true, credential_entitlement: true, ballot: false, credential: false, blockers: true, flush: true, switch_wal: false, ls_waldir: false, checkpoint: false })
  await s.db.query('vacuum full ballot_box')
  await assert.rejects(s.db.query('checkpoint'), (err) => sqlState(err) === '42501')
  await assert.rejects(s.db.query('select pg_switch_wal()'), (err) => sqlState(err) === '42501')
})
