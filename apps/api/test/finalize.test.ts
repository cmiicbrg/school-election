// Finalizing an election through the API: who may and when, the clean-up
// before the declaration, the declared outcomes with their versions, the
// runoff keys voided where no runoff was held, the event with the reason,
// what the result and the keys route show afterwards, that nothing of the
// election changes any more but its export, and that a round changed
// between the clean-up and the declaration refuses.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { TALLY_VERSION } from '@school-election/election-core'
import { cleanUp } from '../lib/cleanup.ts'
import type { ExportDocument } from '../lib/export-format.ts'
import { verifyExport } from '../lib/export-verify.ts'
import { finalizeElection } from '../lib/finalize.ts'
import { sqlState } from '../lib/pg-errors.ts'
import { DB, withClient } from './helpers/db.ts'
import { accessAs, auditActions } from './helpers/elections.ts'
import { lifecycleOf, ok, preparedElection, refused, runoffBoxOf, vote, voteByKey, type RouteSetup } from './helpers/round-routes.ts'
import { refusedWith } from './helpers/representative-election.ts'

const prepared = (t: TestContext): Promise<RouteSetup> => preparedElection(t, {
  contests: [{ title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1', candidates: [['Berger', 'Paula'], ['Huber', 'Quirin'], ['Wagner', 'Renate']] }],
  groups: [{ name: '1A', contests: [0], keys: 5, runoffKeys: 3 }],
})

interface Result {
  contests: { contestId: string, outcome: { kind: string, positions?: { candidateId: string }[] } }[]
  finalized: { reason: string, actorName: string, at: string } | null
}

/** The first round voted so that it needs a runoff, and closed. */
async function firstRound(x: RouteSetup): Promise<void> {
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  await voteAndClose(x)
}

/** The open first round voted so that it needs a runoff, and closed. */
async function voteAndClose(x: RouteSetup): Promise<void> {
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  const orders = [[paula, quirin, renate], [paula, renate, quirin], [quirin, paula, renate], [quirin, renate, paula], [renate, paula, quirin]]
  for (const [index, order] of orders.entries()) assert.deepEqual(await vote(x, x.credentialIds[index] ?? '', order), { cast: true })
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/close`))
}

/** The runoff activated, voted (Paula wins) and closed. */
async function runoffRound(x: RouteSetup): Promise<void> {
  ok(await x.anna.request('POST', `${x.base}/rounds/runoff/activate`))
  const [paula, quirin] = x.contest.candidateIds as [string, string]
  const box = await runoffBoxOf(x, x.contest.id)
  for (const [key, choice] of [[x.runoffKeys['1A']?.[0], paula], [x.runoffKeys['1A']?.[1], paula], [x.runoffKeys['1A']?.[2], quirin]] as const) {
    ok((await voteByKey(x, key ?? '', box, { kind: 'ranking', ranking: [choice] })).cast ?? assert.fail('no ballot'))
  }
  ok(await x.anna.request('POST', `${x.base}/rounds/runoff/close`))
}

const finalize = (x: RouteSetup, by = x.anna, body: object = { reason: 'Ergebnis festgestellt; die Stichwahl findet nicht statt, da die Kandidatin zurückgezogen hat.' }) =>
  by.request('POST', `${x.base}/finalize`, body)

test('the owner finalizes once the regular round has closed and no round is open: the declared outcomes, the runoff keys voided, the event, the result, the witness\'s keys; afterwards nothing changes but the export', DB, async (t) => {
  const x = await prepared(t)
  refused(await finalize(x), 409, 'round_planned')
  refused(await finalize(x, x.carla), 403, 'forbidden')
  refused(await finalize(x, x.wanda), 403, 'forbidden')
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  refused(await finalize(x), 409, 'round_open')
  await voteAndClose(x)
  assert.equal((await finalize(x, x.anna, {})).statusCode, 400)
  assert.equal((await finalize(x, x.anna, { reason: '' })).statusCode, 400)
  refused(await finalize(x, x.carla), 403, 'forbidden')

  const declared = ok<{ state: string, contests: { contestId: string, kind: string }[], batchesVoided: number }>(await finalize(x))
  assert.deepEqual(declared, { state: 'final', contests: [{ contestId: x.contest.id, kind: 'runoff-required' }], batchesVoided: 1 })
  assert.deepEqual((await lifecycleOf(x.wanda, x.base)).lifecycle, { election: 'final', regular: 'closed', runoff: null })
  assert.deepEqual((await auditActions(x.anna, x.id)).slice(-2), ['credential-batch.voided', 'election.finalized'])
  await withClient(x.s.ownerUrl, async (client) => {
    const { rows: [event] } = await client.query<{ metadata: Record<string, unknown>, actor_name: string }>(
      `select metadata, actor_name from audit_event where election_id = $1 and action = 'election.finalized'`, [x.id],
    )
    assert.deepEqual(event?.metadata, { reason: 'Ergebnis festgestellt; die Stichwahl findet nicht statt, da die Kandidatin zurückgezogen hat.', resolved: 0, unresolved: 1 })
    assert.equal(event?.actor_name, 'Anna Lehrerin')
    const { rows: stored } = await client.query<{ contest_id: string, kind: string, tally_version: number, app_version: string, git_sha: string }>(
      'select contest_id, kind, tally_version, app_version, git_sha from final_outcome where election_id = $1', [x.id],
    )
    assert.deepEqual(stored, [{ contest_id: x.contest.id, kind: 'runoff-required', tally_version: TALLY_VERSION, app_version: 'dev', git_sha: 'unknown' }])
    const { rows: batches } = await client.query<{ round_kind: string, state: string }>('select round_kind, state from credential_batch where election_id = $1 order by round_kind', [x.id])
    assert.deepEqual(batches, [{ round_kind: 'regular', state: 'issued' }, { round_kind: 'runoff', state: 'void' }])
    // The runtime role changes nothing of a final election, not even by hand.
    await assert.rejects(client.query(`update election set title = 'Anders' where id = $1`, [x.id]), (err) => sqlState(err) === '55000')
  })

  // The result: the declared outcome, and the finalization; the witness reads the voided runoff keys, none used.
  const result = ok<Result>(await x.wanda.request('GET', `${x.base}/result`))
  assert.equal(result.contests[0]?.outcome.kind, 'runoff-required')
  assert.equal(result.finalized?.reason, 'Ergebnis festgestellt; die Stichwahl findet nicht statt, da die Kandidatin zurückgezogen hat.')
  assert.equal(result.finalized?.actorName, 'Anna Lehrerin')
  assert.match(result.finalized?.at ?? '', /^\d{4}-\d{2}-\d{2}T/)
  const { batches } = ok<{ batches: { id: string, roundKind: string, state: string }[] }>(await x.wanda.request('GET', `${x.base}/batches`))
  const runoffBatch = batches.find((batch) => batch.roundKind === 'runoff') ?? assert.fail('no runoff batch')
  assert.equal(runoffBatch.state, 'void')
  const keys = ok<{ keys: { key: string, used: boolean | null }[] }>(await x.wanda.request('GET', `${x.base}/batches/${runoffBatch.id}`))
  assert.deepEqual(keys.keys.map((entry) => entry.used), [false, false, false])
  assert.deepEqual(keys.keys.map((entry) => entry.key), x.runoffKeys['1A'])

  // Final: every change is refused, by the guard; the export still works and carries the declaration.
  refused(await finalize(x), 409, 'election_final')
  refused(await x.anna.request('PATCH', x.base, { title: 'Anders' }), 409, 'election_final')
  refused(await x.anna.request('POST', `${x.base}/lots`, { contestId: x.contest.id, lotId: 'x', order: x.contest.candidateIds.slice(0, 2), reason: 'x' }), 409, 'election_final')
  refused(await x.anna.request('POST', `${x.base}/rounds/runoff/activate`), 409, 'election_final')
  refused(await x.anna.request('POST', `${x.base}/rounds/regular/open`), 409, 'election_final')
  refused(await x.anna.request('POST', `${x.base}/members`, { email: 'neu@schule.example.org', role: 'witness' }), 409, 'election_final')
  const { voterGroups } = ok<{ voterGroups: { id: string }[] }>(await x.anna.request('GET', `${x.base}/configuration`))
  refused(await x.anna.request('POST', `${x.base}/batches`, { voterGroupId: voterGroups[0]?.id, roundKind: 'runoff', count: 1 }), 409, 'election_final')
  refused(await x.anna.request('DELETE', x.base), 409, 'election_final')
  const exported = await x.wanda.request('POST', `${x.base}/export`)
  assert.equal(exported.statusCode, 200, exported.body)
  const document = JSON.parse(exported.body) as ExportDocument
  assert.equal(document.election.state, 'final')
  assert.deepEqual(document.finalOutcomes.map((entry) => [entry.contestId, entry.kind, entry.tallyVersion, entry.appVersion, entry.gitSha]), [[x.contest.id, 'runoff-required', TALLY_VERSION, 'dev', 'unknown']])
  assert.deepEqual(document.audit.events.slice(-3).map((event) => event.action), ['result.computed', 'credential-batch.voided', 'election.finalized'])
})

test('with the runoff held: the runoff batch stays as it is, the outcome is final, and the event counts it as resolved', DB, async (t) => {
  const x = await prepared(t)
  await firstRound(x)
  await runoffRound(x)
  const [paula] = x.contest.candidateIds
  assert.deepEqual(ok(await finalize(x)), { state: 'final', contests: [{ contestId: x.contest.id, kind: 'final' }], batchesVoided: 0 })
  assert.deepEqual((await auditActions(x.anna, x.id)).slice(-3), ['round.closed', 'result.computed', 'election.finalized'])
  const result = ok<Result>(await x.wanda.request('GET', `${x.base}/result`))
  assert.equal(result.contests[0]?.outcome.kind, 'final')
  assert.equal(result.contests[0]?.outcome.positions?.[0]?.candidateId, paula)
  const { rows: [event] } = await withClient(x.s.ownerUrl, (client) => client.query<{ metadata: Record<string, unknown> }>(
    `select metadata from audit_event where election_id = $1 and action = 'election.finalized'`, [x.id],
  ))
  assert.deepEqual([event?.metadata.resolved, event?.metadata.unresolved], [1, 0])
  const { rows: batches } = await withClient(x.s.ownerUrl, (client) => client.query<{ state: string }>('select state from credential_batch where election_id = $1', [x.id]))
  assert.deepEqual(batches.map((batch) => batch.state), ['issued', 'issued'])
})

test('a round that changed between the clean-up and the declaration refuses the declaration; the next request cleans up again', DB, async (t) => {
  const x = await prepared(t)
  await firstRound(x)
  const stale = await cleanUp(x.s.db, x.id)
  await runoffRound(x)
  const access = await accessAs(x.s.ownerUrl, x.id, 'owner')
  await assert.rejects(
    x.s.db.tx((client) => finalizeElection(client, access, { version: 'dev', gitSha: 'unknown' }, 'Grund', stale)),
    refusedWith(409, 'election_changed'),
  )
  assert.deepEqual((await lifecycleOf(x.anna, x.base)).lifecycle, { election: 'active', regular: 'closed', runoff: 'closed' })
  assert.equal(ok<{ state: string }>(await finalize(x)).state, 'final')
})

test('a final election\'s result and export stand on the declaration, not on today\'s resolution: with a recorded lot damaged past the triggers, both still answer, and the verifier sees it', DB, async (t) => {
  const x = await prepared(t)
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  // First places 2, 1, 1; twenty points each: Quirin and Renate tied for the second runoff place, a lot.
  for (const [index, order] of [[paula, quirin, renate], [paula, renate, quirin], [quirin, renate, paula], [renate, quirin, paula]].entries()) {
    assert.deepEqual(await vote(x, x.credentialIds[index] ?? '', order), { cast: true })
  }
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/close`))
  const before = ok<{ contests: { outcome: { lots?: { id: string }[] } }[] }>(await x.anna.request('GET', `${x.base}/result`))
  const lot = before.contests[0]?.outcome.lots?.[0] ?? assert.fail('no lot')
  ok(await x.anna.request('POST', `${x.base}/lots`, { contestId: x.contest.id, lotId: lot.id, order: [renate, quirin], reason: 'Los gezogen' }))
  assert.deepEqual(ok<{ contests: { kind: string }[] }>(await finalize(x)).contests, [{ contestId: x.contest.id, kind: 'runoff-required' }])

  // The lot's order damaged, past the trigger that keeps a recorded lot, to what resolve refuses.
  await withClient(x.s.ownerUrl, async (client) => {
    await client.query('begin')
    await client.query('set local session_replication_role = replica')
    await client.query('update lot_decision set drawn = array[candidates[1], candidates[1]] where election_id = $1', [x.id])
    await client.query('commit')
  })
  const result = ok<Result>(await x.wanda.request('GET', `${x.base}/result`))
  assert.equal(result.contests[0]?.outcome.kind, 'runoff-required')
  assert.equal(result.finalized?.reason.startsWith('Ergebnis festgestellt'), true)
  const exported = await x.wanda.request('POST', `${x.base}/export`)
  assert.equal(exported.statusCode, 200, exported.body)
  const document = JSON.parse(exported.body) as ExportDocument
  assert.equal(document.finalOutcomes[0]?.kind, 'runoff-required')
  const report = verifyExport(document)
  assert.equal(report.ok, false)
  assert.ok(report.checks.some((check) => !check.ok && check.name === 'final outcome: Schulsprecher/in'), 'the declared outcome no longer follows from the file\'s lots')
})
