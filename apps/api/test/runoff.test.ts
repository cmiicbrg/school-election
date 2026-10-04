// The runoff through the API: the first round closed with a runoff
// required, the activation with the pair on fresh keys, the runoff voted
// through the voter routes, closed and counted, the outcome with the
// principal by the runoff and the deputies by first-round points, the
// first-round snapshot untouched, and the log complete.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DB, withClient } from './helpers/db.ts'
import { auditActions } from './helpers/elections.ts'
import { lifecycleOf, ok, preparedElection, refused, runoffBoxOf, vote, voteByKey, type RouteSetup } from './helpers/round-routes.ts'

/** The school contest with three candidates, five keys and three runoff keys for 1A. */
const prepared = (t: TestContext): Promise<RouteSetup> => preparedElection(t, {
  contests: [{ title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1', candidates: [['Berger', 'Paula'], ['Huber', 'Quirin'], ['Wagner', 'Renate']] }],
  groups: [{ name: '1A', contests: [0], keys: 5, runoffKeys: 3 }, { name: '2B', contests: [0] }],
})

interface Outcome {
  kind: string
  runoffCandidates?: string[]
  positions?: { function: string, candidateId: string | null, basis: string }[]
  lots?: { id: string, reason: string, candidates: string[] }[]
}

interface ElectionResult {
  contests: { contestId: string, first: { inputSha256: string, result: { kind: string } }, runoff: { result: { kind: string, winnerId?: string, runoffOf: string | null } } | null, lots: unknown[], outcome: Outcome }[]
}

test('the runoff: activated with the pair on fresh keys, voted through the voter routes, counted with the first round untouched, and logged', DB, async (t) => {
  const x = await prepared(t)
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  const orders = [[paula, quirin, renate], [paula, renate, quirin], [quirin, paula, renate], [quirin, renate, paula], [renate, paula, quirin]]
  for (const [index, order] of orders.entries()) assert.deepEqual(await vote(x, x.credentialIds[index] ?? '', order), { cast: true })
  // Before the close nobody activates, and the election's result is not there yet.
  refused(await x.anna.request('POST', `${x.base}/rounds/runoff/activate`), 409, 'round_open')
  refused(await x.anna.request('GET', `${x.base}/result`), 409, 'round_open')

  const closed = ok<{ contests: { outcome: string }[] }>(await x.anna.request('POST', `${x.base}/rounds/regular/close`))
  assert.deepEqual(closed.contests.map((contest) => contest.outcome), ['runoff-required'])
  const firstRound = ok<unknown>(await x.anna.request('GET', `${x.base}/rounds/regular/result`))
  for (const by of [x.anna, x.carla, x.wanda]) {
    const { contests: [contest] } = ok<ElectionResult>(await by.request('GET', `${x.base}/result`))
    assert.equal(contest?.outcome.kind, 'runoff-required')
    assert.deepEqual([...contest?.outcome.runoffCandidates ?? []].sort(), [paula, quirin].sort())
    assert.equal(contest?.runoff, null)
    assert.deepEqual(contest?.lots, [])
  }
  assert.deepEqual(ok<{ round: string | null }>(await x.wanda.request('GET', `${x.base}/rounds/runoff/turnout`)).round, null)
  refused(await x.wanda.request('GET', `${x.base}/rounds/runoff/result`), 409, 'no_runoff')
  // Keys before the activation: a runoff key's round does not exist yet, a first-round key's round is over.
  const [runoff1, runoff2, runoff3] = x.runoffKeys['1A'] as [string, string, string]
  refused((await voteByKey(x, runoff1, x.boxId, { kind: 'ranking', ranking: [paula] })).redeemed, 409, 'round_planned')
  refused((await voteByKey(x, x.keys['1A']?.[0] ?? '', x.boxId, { kind: 'ranking', ranking: [paula] })).redeemed, 409, 'round_closed')

  refused(await x.wanda.request('POST', `${x.base}/rounds/runoff/activate`), 403, 'forbidden')
  const activated = ok<{ election: string, round: string, contests: { contestId: string, candidates: string[] }[], keys: number }>(await x.carla.request('POST', `${x.base}/rounds/runoff/activate`))
  assert.deepEqual(activated, { election: 'active', round: 'open', contests: [{ contestId: x.contest.id, candidates: [paula, quirin] }], keys: 3 })
  refused(await x.carla.request('POST', `${x.base}/rounds/runoff/activate`), 409, 'runoff_activated')
  assert.deepEqual((await lifecycleOf(x.wanda, x.base)).lifecycle, { election: 'active', regular: 'closed', runoff: 'open' })
  for (const by of [x.anna, x.carla, x.wanda]) refused(await by.request('GET', `${x.base}/rounds/runoff/result`), 409, 'round_open')
  // The first round's result stays readable while the runoff is open; the outcome waits for it.
  assert.equal(ok<ElectionResult>(await x.wanda.request('GET', `${x.base}/result`)).contests[0]?.outcome.kind, 'runoff-required')
  // No runoff batch is issued any more.
  const { voterGroups } = ok<{ voterGroups: { id: string, name: string }[] }>(await x.anna.request('GET', `${x.base}/configuration`))
  refused(await x.anna.request('POST', `${x.base}/batches`, { voterGroupId: voterGroups.find((group) => group.name === '1A')?.id, roundKind: 'runoff', count: 2 }), 409, 'voting_started')

  // The runoff voted: the pair as one choice; a candidate outside the pair, a first-round key and a second ballot are refused.
  const box = await runoffBoxOf(x, x.contest.id)
  const first = await voteByKey(x, runoff1, box, { kind: 'ranking', ranking: [paula] })
  const seen = ok<{ round: string, contests: { rulesetId: string, activeSlots: number, candidates: { id: string }[] }[] }>(first.redeemed)
  assert.equal(seen.round, 'open')
  assert.deepEqual(seen.contests.map((contest) => [contest.rulesetId, contest.activeSlots, contest.candidates.map((candidate) => candidate.id)]), [['single-choice-v1', 1, [paula, quirin]]])
  assert.deepEqual(ok(first.cast ?? assert.fail('no ballot')), { done: true, remaining: 0 })
  const outside = await voteByKey(x, runoff2, box, { kind: 'ranking', ranking: [renate] })
  refused(outside.cast ?? assert.fail('no ballot'), 400, 'invalid_ballot')
  assert.deepEqual(ok(((await voteByKey(x, runoff2, box, { kind: 'ranking', ranking: [paula] })).cast) ?? assert.fail('no ballot')), { done: true, remaining: 0 })
  assert.deepEqual(ok(((await voteByKey(x, runoff3, box, { kind: 'ranking', ranking: [quirin] })).cast) ?? assert.fail('no ballot')), { done: true, remaining: 0 })
  refused((await voteByKey(x, runoff3, box, { kind: 'ranking', ranking: [quirin] })).cast ?? assert.fail('no ballot'), 409, 'already_voted')
  refused((await voteByKey(x, x.keys['1A']?.[1] ?? '', box, { kind: 'ranking', ranking: [paula] })).redeemed, 409, 'round_closed')
  assert.deepEqual(ok(await x.wanda.request('GET', `${x.base}/rounds/runoff/turnout`)), { round: 'open', keys: { issued: 3, used: 3 }, contests: [{ contestId: x.contest.id, issued: 3, used: 3 }] })

  refused(await x.wanda.request('POST', `${x.base}/rounds/runoff/close`), 403, 'forbidden')
  const closedRunoff = ok<{ election: string, round: string, ballots: number, contests: { contestId: string, outcome: string }[] }>(await x.anna.request('POST', `${x.base}/rounds/runoff/close`))
  assert.deepEqual(closedRunoff, { election: 'active', round: 'closed', ballots: 3, contests: [{ contestId: x.contest.id, outcome: 'final' }] })
  refused((await voteByKey(x, runoff3, box, { kind: 'ranking', ranking: [quirin] })).redeemed, 409, 'round_closed')
  assert.deepEqual((await lifecycleOf(x.wanda, x.base)).lifecycle, { election: 'active', regular: 'closed', runoff: 'closed' })

  for (const by of [x.anna, x.carla, x.wanda]) {
    const runoffResult = ok<{ round: string, contests: { result: { kind: string, winnerId: string, runoffOf: string } }[] }>(await by.request('GET', `${x.base}/rounds/runoff/result`))
    assert.deepEqual(runoffResult.contests.map((contest) => [contest.result.kind, contest.result.winnerId, contest.result.runoffOf]), [['elected', paula, x.contest.id]])
    const { contests: [contest] } = ok<ElectionResult>(await by.request('GET', `${x.base}/result`))
    assert.ok(contest)
    assert.equal(contest.runoff?.result.winnerId, paula)
    assert.equal(contest.outcome.kind, 'final')
    assert.deepEqual(contest.outcome.positions, [
      { function: 'school-speaker', candidateId: paula, basis: 'runoff' },
      { function: 'school-speaker-deputy-1', candidateId: quirin, basis: 'points' },
      { function: 'school-speaker-deputy-2', candidateId: renate, basis: 'points' },
      { function: 'sga-deputy-1', candidateId: null, basis: 'vacant' },
      { function: 'sga-deputy-2', candidateId: null, basis: 'vacant' },
      { function: 'sga-deputy-3', candidateId: null, basis: 'vacant' },
    ])
  }
  // The first-round snapshot is what it was: digest, result and outcome, to the byte.
  assert.deepEqual(ok<unknown>(await x.anna.request('GET', `${x.base}/rounds/regular/result`)), firstRound)

  assert.deepEqual((await auditActions(x.anna, x.id)).slice(-7), ['round.opened', 'round.closed', 'result.computed', 'runoff.pair', 'runoff.activated', 'round.closed', 'result.computed'])
  const { rows: events } = await withClient(x.s.ownerUrl, (client) => client.query<{ action: string, metadata: Record<string, unknown> }>(
    `select action, metadata from audit_event where election_id = $1 and action in ('runoff.pair', 'runoff.activated', 'round.closed', 'result.computed') order by seq`, [x.id],
  ))
  assert.deepEqual(events.map((event) => [event.action, event.metadata]).slice(2), [
    ['runoff.pair', { contest: x.contest.id, first: paula, second: quirin }],
    ['runoff.activated', { round: 'runoff', contests: 1, keys: 3 }],
    ['round.closed', { round: 'runoff', ballots: 3 }],
    ['result.computed', { contest: x.contest.id, round: 'runoff', inputSha256: events[5]?.metadata.inputSha256, ballots: 3, outcome: 'final' }],
  ])
})

test('no runoff where none is needed: a first-round majority leaves nothing to activate', DB, async (t) => {
  const x = await prepared(t)
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  for (const [index, order] of [[paula, quirin, renate], [paula, renate, quirin], [paula, quirin, renate], [quirin, paula, renate]].entries()) {
    assert.deepEqual(await vote(x, x.credentialIds[index] ?? '', order), { cast: true })
  }
  assert.deepEqual(ok<{ contests: { outcome: string }[] }>(await x.anna.request('POST', `${x.base}/rounds/regular/close`)).contests.map((contest) => contest.outcome), ['final'])
  refused(await x.anna.request('POST', `${x.base}/rounds/runoff/activate`), 409, 'no_runoff')
  assert.deepEqual((await lifecycleOf(x.wanda, x.base)).lifecycle, { election: 'active', regular: 'closed', runoff: null })
  const { contests: [contest] } = ok<ElectionResult>(await x.wanda.request('GET', `${x.base}/result`))
  assert.equal(contest?.outcome.kind, 'final')
  assert.equal(contest?.outcome.positions?.[0]?.basis, 'majority')
})
