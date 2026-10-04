// The round routes: who may open and close, what the lifecycle allows
// before, while and after, what every member sees of turnout and the
// result and when, and the whole first round through the API from a
// prepared election to the result with its trace.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DB, withClient } from './helpers/db.ts'
import { auditActions, createElection } from './helpers/elections.ts'
import { lifecycleOf, ok, preparedElection, refused, vote, type RouteSetup } from './helpers/round-routes.ts'

/** The school contest with three candidates, voted in by 1A and 2B, five keys for 1A. */
const prepared = (t: TestContext): Promise<RouteSetup> => preparedElection(t, {
  title: 'Schulsprecher/in',
  rulesetId: 'at-school-speaker-v1',
  candidates: [['Berger', 'Paula'], ['Huber', 'Quirin'], ['Wagner', 'Renate']],
  groups: ['1A', '2B'],
  keys: 5,
})

test('opening: those who run rounds, from prepared only, once; then the structure, the candidates and the keys are fixed', DB, async (t) => {
  const x = await prepared(t)
  refused(await x.wanda.request('POST', `${x.base}/rounds/regular/open`), 403, 'forbidden')
  const draft = await createElection(x.anna, 'Noch ein Entwurf')
  refused(await x.anna.request('POST', `/api/elections/${draft}/rounds/regular/open`), 409, 'not_prepared')
  refused(await x.anna.request('POST', `${x.base}/rounds/regular/close`), 409, 'round_planned')

  assert.deepEqual(ok(await x.carla.request('POST', `${x.base}/rounds/regular/open`)), { election: 'active', round: 'open' })
  const detail = await lifecycleOf(x.wanda, x.base)
  assert.equal(detail.state, 'active')
  assert.deepEqual(detail.lifecycle, { election: 'active', regular: 'open', runoff: null })
  refused(await x.anna.request('POST', `${x.base}/rounds/regular/open`), 409, 'voting_started')
  refused(await x.anna.request('POST', `${x.base}/unprepare`), 409, 'voting_started')

  const [candidate] = x.contest.candidateIds
  refused(await x.anna.request('PATCH', `${x.base}/candidates/${candidate}`, { surname: 'Anders', givenName: 'Paula' }), 409, 'voting_started')
  refused(await x.anna.request('POST', `${x.base}/contests`, { title: 'Noch einer', rulesetId: 'single-choice-v1' }), 409, 'not_draft')
  const { voterGroups } = ok<{ voterGroups: { id: string, name: string }[] }>(await x.anna.request('GET', `${x.base}/configuration`))
  refused(await x.anna.request('POST', `${x.base}/batches`, { voterGroupId: voterGroups[0]!.id, roundKind: 'regular', count: 3 }), 409, 'voting_started')
  assert.deepEqual((await auditActions(x.anna, x.id)).slice(-1), ['round.opened'])
})

test('no role sees a result while the round is open; everyone sees turnout, as counts only', DB, async (t) => {
  const x = await prepared(t)
  for (const by of [x.anna, x.carla, x.wanda]) refused(await by.request('GET', `${x.base}/rounds/regular/result`), 409, 'round_planned')
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  for (const by of [x.anna, x.carla, x.wanda]) refused(await by.request('GET', `${x.base}/rounds/regular/result`), 409, 'round_open')

  const [first, second] = x.credentialIds as [string, string]
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  assert.deepEqual(await vote(x, first, [paula, quirin, renate]), { cast: true })
  assert.deepEqual(await vote(x, second, [paula, renate, quirin]), { cast: true })
  for (const by of [x.anna, x.carla, x.wanda]) {
    const turnout = ok<{ round: string, keys: { issued: number, used: number }, contests: { contestId: string, issued: number, used: number }[] }>(await by.request('GET', `${x.base}/rounds/regular/turnout`))
    assert.deepEqual(turnout, { round: 'open', keys: { issued: 5, used: 2 }, contests: [{ contestId: x.contest.id, issued: 5, used: 2 }] })
  }
})

test('closing seals and counts: the result for every member from then on, a vote after it refused, and the log complete', DB, async (t) => {
  const x = await prepared(t)
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  const [first, second, third, fourth, fifth] = x.credentialIds as [string, string, string, string, string]
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  for (const [key, order] of [[first, [paula, quirin, renate]], [second, [paula, renate, quirin]], [third, [paula, quirin, renate]], [fourth, [quirin, paula, renate]]] as const) {
    assert.deepEqual(await vote(x, key, [...order]), { cast: true })
  }

  refused(await x.wanda.request('POST', `${x.base}/rounds/regular/close`), 403, 'forbidden')
  const closed = ok<{ election: string, round: string, ballots: number, contests: { contestId: string, outcome: string }[] }>(await x.anna.request('POST', `${x.base}/rounds/regular/close`))
  assert.deepEqual(closed, { election: 'active', round: 'closed', ballots: 4, contests: [{ contestId: x.contest.id, outcome: 'final' }] })
  refused(await x.anna.request('POST', `${x.base}/rounds/regular/close`), 409, 'round_closed')
  assert.deepEqual(await vote(x, fifth, [paula, quirin, renate]), { cast: false, reason: 'refused' })
  assert.deepEqual((await lifecycleOf(x.wanda, x.base)).lifecycle, { election: 'active', regular: 'closed', runoff: null })

  interface Stored {
    round: string
    contests: {
      contestId: string
      inputSha256: string
      tallyVersion: number
      appVersion: string
      gitSha: string
      result: { kind: string, winnerId?: string, statistics: { validBallots: number, candidates: { candidateId: string, firstPlaces: number, points: number }[] }, trace: { kind: string }[] }
      outcome: { kind: string, positions?: { candidateId: string }[] }
    }[]
  }
  let seen: Stored | undefined
  for (const by of [x.anna, x.carla, x.wanda]) {
    const stored = ok<Stored>(await by.request('GET', `${x.base}/rounds/regular/result`))
    if (seen) assert.deepEqual(stored, seen)
    seen = stored
  }
  assert.ok(seen)
  assert.equal(seen.round, 'closed')
  const [result] = seen.contests
  assert.ok(result)
  assert.equal(result.contestId, x.contest.id)
  assert.match(result.inputSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual({ tallyVersion: result.tallyVersion, appVersion: result.appVersion, gitSha: result.gitSha }, { tallyVersion: 2, appVersion: 'dev', gitSha: 'unknown' })
  assert.equal(result.result.kind, 'elected')
  assert.equal(result.result.winnerId, paula)
  assert.equal(result.result.statistics.validBallots, 4)
  // Three candidates: three active slots of six, five and four points.
  assert.deepEqual(result.result.statistics.candidates.map((candidate) => [candidate.candidateId, candidate.firstPlaces, candidate.points]), [[paula, 3, 23], [quirin, 1, 20], [renate, 0, 17]])
  assert.ok(result.result.trace.length > 0)
  assert.equal(result.outcome.kind, 'final')
  assert.equal(result.outcome.positions?.[0]?.candidateId, paula)

  const turnout = ok<{ round: string, keys: { issued: number, used: number } }>(await x.wanda.request('GET', `${x.base}/rounds/regular/turnout`))
  assert.deepEqual([turnout.round, turnout.keys], ['closed', { issued: 5, used: 4 }])
  assert.deepEqual((await auditActions(x.anna, x.id)).slice(-3), ['round.opened', 'round.closed', 'result.computed'])

  // A closed round whose snapshots are gone (a database changed by hand) is an error, never an empty result.
  await withClient(x.s.ownerUrl, (client) => client.query('begin; set local session_replication_role = replica; delete from result_snapshot; commit'))
  refused(await x.wanda.request('GET', `${x.base}/rounds/regular/result`), 500, 'internal_error')
})

test('an issued batch stays in turnout when a draft edit removed its keys\' entitlements: the keys are still on paper', DB, async (t) => {
  const x = await prepared(t)
  ok(await x.anna.request('POST', `${x.base}/unprepare`))
  // Removing the contest takes its ballot box and every entitlement to it with it; the batch and its keys stay issued.
  assert.equal((await x.anna.request('DELETE', `${x.base}/contests/${x.contest.id}`)).statusCode, 204)
  const turnout = ok<{ round: string | null, keys: { issued: number, used: number }, contests: unknown[] }>(await x.wanda.request('GET', `${x.base}/rounds/regular/turnout`))
  assert.deepEqual(turnout, { round: 'planned', keys: { issued: 5, used: 0 }, contests: [] })
})
