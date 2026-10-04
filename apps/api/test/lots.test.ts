// Lots the officials drew, recorded through the API: for the runoff entry,
// before the activation, and for the positions after the runoff; who may,
// what is refused, what the log and the result carry, and that the order
// recorded is the order applied.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DB, withClient } from './helpers/db.ts'
import { auditActions } from './helpers/elections.ts'
import { ok, preparedElection, refused, runoffBoxOf, vote, voteByKey, type RouteSetup } from './helpers/round-routes.ts'

const prepared = (t: TestContext): Promise<RouteSetup> => preparedElection(t, {
  contests: [{ title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1', candidates: [['Berger', 'Paula'], ['Huber', 'Quirin'], ['Wagner', 'Renate']] }],
  groups: [{ name: '1A', contests: [0], keys: 4, runoffKeys: 3 }],
})

interface Lot {
  id: string
  reason: string
  candidates: string[]
  qualified?: string[]
  seats?: number
  positions?: string[]
}

interface Outcome {
  kind: string
  lots?: Lot[]
  runoffCandidates?: string[]
  positions?: { function: string, candidateId: string | null, basis: string }[]
}

interface ElectionResult {
  contests: { contestId: string, lots: { lotId: string, candidates: string[], drawn: string[], reason: string, actorName: string, recordedAt: string }[], outcome: Outcome }[]
}

test('a lot for the runoff entry: required, recorded once by someone who runs rounds with exactly the tied set, applied as drawn; then a lot for the deputies after the runoff', DB, async (t) => {
  const x = await prepared(t)
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  // First places 2, 1, 1; twenty points each: Quirin and Renate are tied for the second place on first places and on points.
  for (const [index, order] of [[paula, quirin, renate], [paula, renate, quirin], [quirin, renate, paula], [renate, quirin, paula]].entries()) {
    assert.deepEqual(await vote(x, x.credentialIds[index] ?? '', order), { cast: true })
  }
  assert.deepEqual(ok<{ contests: { outcome: string }[] }>(await x.anna.request('POST', `${x.base}/rounds/regular/close`)).contests.map((contest) => contest.outcome), ['lot-required'])
  const before = ok<ElectionResult>(await x.wanda.request('GET', `${x.base}/result`)).contests[0] ?? assert.fail('no contest')
  const entryLot = before.outcome.lots?.[0] ?? assert.fail('no lot')
  assert.equal(entryLot.reason, 'runoff-entry')
  assert.deepEqual([[...entryLot.candidates].sort(), entryLot.qualified, entryLot.seats], [[quirin, renate].sort(), [paula], 1])
  refused(await x.anna.request('POST', `${x.base}/rounds/runoff/activate`), 409, 'lot_required')

  const record = (by: typeof x.anna, body: object) => by.request('POST', `${x.base}/lots`, body)
  const drawn = { contestId: x.contest.id, lotId: entryLot.id, order: [renate, quirin], reason: 'Los gezogen von der Wahlkommission, 3. Oktober' }
  refused(await record(x.wanda, drawn), 403, 'forbidden')
  assert.equal((await record(x.carla, { ...drawn, reason: '' })).statusCode, 400)
  assert.equal((await record(x.carla, { ...drawn, order: [renate] })).statusCode, 400)
  refused(await record(x.carla, { ...drawn, order: [renate, paula] }), 400, 'not_the_tied_set')
  refused(await record(x.carla, { ...drawn, order: [renate, quirin, paula] }), 400, 'not_the_tied_set')
  refused(await record(x.carla, { ...drawn, lotId: 'positions:school-speaker-deputy-1' }), 409, 'lot_not_required')
  refused(await record(x.carla, { ...drawn, contestId: '00000000-0000-4000-8000-000000000000' }), 404, 'not_found')
  const recorded = ok<{ contestId: string, outcome: Outcome }>(await record(x.carla, drawn))
  assert.equal(recorded.outcome.kind, 'runoff-required')
  assert.deepEqual(recorded.outcome.runoffCandidates, [paula, renate], 'the first drawn enters')
  refused(await record(x.carla, drawn), 409, 'duplicate_lot')
  refused(await record(x.carla, { ...drawn, order: [quirin, renate] }), 409, 'duplicate_lot')

  const after = ok<ElectionResult>(await x.wanda.request('GET', `${x.base}/result`)).contests[0] ?? assert.fail('no contest')
  assert.equal(after.outcome.kind, 'runoff-required')
  assert.deepEqual(after.lots.map((lot) => [lot.lotId, lot.candidates, lot.drawn, lot.reason, lot.actorName]), [[entryLot.id, entryLot.candidates, [renate, quirin], drawn.reason, 'Carla Kollegin']])
  assert.deepEqual((await auditActions(x.anna, x.id)).slice(-1), ['lot.recorded'])
  const { rows: [event] } = await withClient(x.s.ownerUrl, (client) => client.query<{ metadata: Record<string, unknown>, actor_name: string }>(
    `select metadata, actor_name from audit_event where election_id = $1 and action = 'lot.recorded'`, [x.id],
  ))
  assert.deepEqual(event?.metadata, { contest: x.contest.id, lotId: entryLot.id, candidates: entryLot.candidates.join(','), order: `${renate},${quirin}`, reason: drawn.reason })
  assert.equal(event?.actor_name, 'Carla Kollegin')
  // Nobody changes or removes a recorded lot, the owner included.
  await withClient(x.s.ownerUrl, async (client) => {
    await assert.rejects(client.query('update lot_decision set drawn = $1 where lot_id = $2', [[quirin, renate], entryLot.id]))
    await assert.rejects(client.query('delete from lot_decision'))
  })

  // The runoff with the pair the lot gave; Renate wins it.
  const activated = ok<{ contests: { candidates: string[] }[] }>(await x.anna.request('POST', `${x.base}/rounds/runoff/activate`))
  assert.deepEqual(activated.contests, [{ contestId: x.contest.id, candidates: [paula, renate] }])
  refused(await record(x.carla, drawn), 409, 'round_open')
  const box = await runoffBoxOf(x, x.contest.id)
  for (const [key, choice] of [[x.runoffKeys['1A']?.[0], renate], [x.runoffKeys['1A']?.[1], renate], [x.runoffKeys['1A']?.[2], paula]] as const) {
    assert.deepEqual(ok((await voteByKey(x, key ?? '', box, { kind: 'ranking', ranking: [choice] })).cast ?? assert.fail('no ballot')), { done: true, remaining: 0 })
  }
  const closedRunoff = ok<{ contests: { outcome: string }[] }>(await x.anna.request('POST', `${x.base}/rounds/runoff/close`))
  assert.deepEqual(closedRunoff.contests.map((contest) => contest.outcome), ['lot-required'], 'Paula and Quirin, twenty points each, compete for the two deputy places')

  const pending = ok<ElectionResult>(await x.wanda.request('GET', `${x.base}/result`)).contests[0] ?? assert.fail('no contest')
  const positionsLot = pending.outcome.lots?.[0] ?? assert.fail('no positions lot')
  assert.equal(positionsLot.reason, 'positions')
  assert.deepEqual([[...positionsLot.candidates].sort(), positionsLot.positions], [[paula, quirin].sort(), ['school-speaker-deputy-1', 'school-speaker-deputy-2']])
  assert.deepEqual(pending.outcome.positions?.slice(0, 3).map((position) => [position.function, position.candidateId, position.basis]), [
    ['school-speaker', renate, 'runoff'], ['school-speaker-deputy-1', null, 'lot-pending'], ['school-speaker-deputy-2', null, 'lot-pending'],
  ])
  // Ids in upper case, as a UUID may be written: the same lot, the same candidates.
  const second = { contestId: x.contest.id.toUpperCase(), lotId: positionsLot.id, order: [quirin.toUpperCase(), paula.toUpperCase()], reason: 'Zweites Los, Stellvertretung' }
  const final = ok<{ outcome: Outcome }>(await record(x.anna, second))
  assert.equal(final.outcome.kind, 'final')
  assert.deepEqual(final.outcome.positions?.map((position) => [position.function, position.candidateId, position.basis]), [
    ['school-speaker', renate, 'runoff'],
    ['school-speaker-deputy-1', quirin, 'lot'],
    ['school-speaker-deputy-2', paula, 'lot'],
    ['sga-deputy-1', null, 'vacant'],
    ['sga-deputy-2', null, 'vacant'],
    ['sga-deputy-3', null, 'vacant'],
  ])
  const done = ok<ElectionResult>(await x.wanda.request('GET', `${x.base}/result`)).contests[0] ?? assert.fail('no contest')
  assert.deepEqual(done.lots.map((lot) => [lot.lotId, lot.drawn]), [[entryLot.id, [renate, quirin]], [positionsLot.id, [quirin, paula]]])
  assert.equal(done.outcome.kind, 'final')
})
